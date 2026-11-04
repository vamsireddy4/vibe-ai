-- Create helper function to generate a random 6-character uppercase alphanumeric code (recreated to ensure it exists on remote)
CREATE OR REPLACE FUNCTION public.generate_agency_code() 
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 1. Add agency_code column to public.profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS agency_code TEXT;

-- 2. Create index on agency_code for faster lookups
CREATE INDEX IF NOT EXISTS profiles_agency_code_idx ON public.profiles(agency_code);

-- 3. Set the DEFAULT value for agency_code in public.agency_access_grants table
-- This guarantees any newly created agency gets a 6-digit code automatically in SQL
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS agency_code TEXT UNIQUE;
ALTER TABLE public.agency_access_grants ALTER COLUMN agency_code SET DEFAULT public.generate_agency_code();

-- 4. Populate existing profiles with their matching agency_code from agency_access_grants
UPDATE public.profiles p
SET agency_code = a.agency_code
FROM public.agency_access_grants a
WHERE p.agency_email IS NOT NULL 
  AND LOWER(TRIM(p.agency_email)) = LOWER(TRIM(a.email))
  AND p.agency_code IS NULL;

-- 5. Recreate client_details view to include the new agency_code field
CREATE OR REPLACE VIEW public.client_details AS
SELECT 
  p.user_id,
  u.email,
  p.full_name,
  p.company_name,
  p.agency_email,
  p.created_by_email,
  u.raw_user_meta_data,
  p.agency_code
FROM public.profiles p
JOIN auth.users u ON p.user_id = u.id;
