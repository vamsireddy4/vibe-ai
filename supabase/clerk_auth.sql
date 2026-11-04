-- Switch the schema from Supabase Auth users to Clerk users.
-- Clerk user ids look like "user_2abc...", so every user_id column becomes text and
-- every policy's auth.uid() becomes the Clerk id from the JWT: (auth.jwt() ->> 'sub').
-- The whole thing is ONE statement (a DO block), so it is all-or-nothing even in the
-- Supabase SQL editor, and safe to run again.
DO $mig$
DECLARE
  r record;
  saved jsonb;
  p jsonb;
  q text;
  wc text;
  failed text := '';
BEGIN
  -- Guard: if an earlier partial run already dropped the policies, stop instead of
  -- leaving every table without access rules.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') = 0 THEN
    RAISE EXCEPTION 'No policies found in public schema: an earlier run dropped them. Do not continue; ask for the repair script.';
  END IF;

  -- 1. The view joins auth.users (Clerk users don't live there). Recreated at the end.
  DROP VIEW IF EXISTS public.client_details;

  -- 2. Save then drop every policy that must be rebuilt.
  SELECT jsonb_agg(to_jsonb(x)) INTO saved FROM (
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
       OR (schemaname = 'storage' AND (qual LIKE '%auth.uid()%' OR with_check LIKE '%auth.uid()%'))
  ) x;

  FOR p IN SELECT * FROM jsonb_array_elements(saved) LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p->>'policyname', p->>'schemaname', p->>'tablename');
  END LOOP;

  -- 3. Drop foreign keys from public tables to auth.users.
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'public' AND c.confrelid = 'auth.users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;

  -- 4. user_id uuid -> text on every public table.
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'user_id' AND data_type = 'uuid'
      AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id TYPE text USING user_id::text', r.table_name);
  END LOOP;

  -- 5. Functions that take a user id: text versions.
  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.has_role(_user_id text, _role app_role)
    RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $b$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
    $b$ $f$;

  DROP FUNCTION IF EXISTS public.increment_minute_balance(uuid, integer);
  DROP FUNCTION IF EXISTS public.deduct_minute_balance(uuid, integer);

  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.increment_minute_balance(p_user_id text, p_seconds integer)
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $b$
    DECLARE v_available integer;
    BEGIN
      INSERT INTO public.user_minute_balances (user_id, available_seconds)
      VALUES (p_user_id, greatest(0, p_seconds))
      ON CONFLICT (user_id) DO UPDATE
        SET available_seconds = public.user_minute_balances.available_seconds + p_seconds
      RETURNING available_seconds INTO v_available;
      RETURN v_available;
    END $b$ $f$;

  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.deduct_minute_balance(p_user_id text, p_seconds integer)
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $b$
    DECLARE v_available integer; v_deducted integer;
    BEGIN
      SELECT available_seconds INTO v_available
      FROM public.user_minute_balances WHERE user_id = p_user_id FOR UPDATE;
      IF v_available IS NULL THEN RETURN 0; END IF;
      v_deducted := least(v_available, greatest(0, p_seconds));
      UPDATE public.user_minute_balances
      SET available_seconds = available_seconds - v_deducted WHERE user_id = p_user_id;
      RETURN v_deducted;
    END $b$ $f$;

  REVOKE ALL ON FUNCTION public.increment_minute_balance(text, integer) FROM public, anon, authenticated;
  REVOKE ALL ON FUNCTION public.deduct_minute_balance(text, integer) FROM public, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.increment_minute_balance(text, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.deduct_minute_balance(text, integer) TO service_role;

  -- 6. Rebuild every saved policy with the Clerk id in place of auth.uid().
  --    Any failure aborts everything with the list, so no policy is silently lost.
  FOR p IN SELECT * FROM jsonb_array_elements(saved) LOOP
    q  := replace(p->>'qual',       'auth.uid()', '(auth.jwt() ->> ''sub'')');
    wc := replace(p->>'with_check', 'auth.uid()', '(auth.jwt() ->> ''sub'')');
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
        p->>'policyname', p->>'schemaname', p->>'tablename', p->>'permissive', p->>'cmd',
        (SELECT string_agg(CASE WHEN x = 'public' THEN 'public' ELSE quote_ident(x) END, ', ')
           FROM jsonb_array_elements_text(p->'roles') x),
        CASE WHEN q  IS NOT NULL THEN ' USING (' || q || ')' ELSE '' END,
        CASE WHEN wc IS NOT NULL THEN ' WITH CHECK (' || wc || ')' ELSE '' END);
    EXCEPTION WHEN others THEN
      failed := failed || format(E'\n  %s.%s "%s": %s', p->>'schemaname', p->>'tablename', p->>'policyname', SQLERRM);
    END;
  END LOOP;
  IF failed <> '' THEN
    RAISE EXCEPTION 'Policies that could not be rebuilt:%', failed;
  END IF;

  -- 7. Profiles keep the email (Clerk owns the user record now); the view reads it from there.
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email text;
  -- Groq model the voice agent uses for this user's calls (Settings → Voice Agent).
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS voice_llm_model text;

  -- security_invoker: the view obeys profiles' row policies instead of exposing every row.
  EXECUTE $v$
    CREATE VIEW public.client_details WITH (security_invoker = true) AS
    SELECT p.user_id, p.email, p.full_name, p.company_name, p.agency_email,
           p.created_by_email, '{}'::jsonb AS raw_user_meta_data, p.agency_code
    FROM public.profiles p $v$;

  DROP TABLE IF EXISTS public._clerk_saved_policies; -- leftover from an earlier version
  RAISE NOTICE 'Clerk migration done: % policies rebuilt', jsonb_array_length(saved);
END $mig$;
