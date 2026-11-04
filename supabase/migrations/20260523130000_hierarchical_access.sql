-- 1. Ensure profiles can track who directly spawned/owns them
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_by_email TEXT;

-- 2. Create an indexed mapping table to handle path lookups for Agency-to-Agency delegations
CREATE TABLE IF NOT EXISTS public.agency_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_agency_email TEXT NOT NULL,
    child_agency_email TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(parent_agency_email, child_agency_email)
);

CREATE INDEX IF NOT EXISTS idx_agency_rel_parent ON public.agency_relationships(parent_agency_email);
CREATE INDEX IF NOT EXISTS idx_agency_rel_child ON public.agency_relationships(child_agency_email);

-- 3. Create a view to securely join public.profiles and auth.users
CREATE OR REPLACE VIEW public.client_details AS
SELECT 
  p.user_id,
  u.email,
  p.full_name,
  p.company_name,
  p.agency_email,
  p.created_by_email,
  u.raw_user_meta_data
FROM public.profiles p
JOIN auth.users u ON p.user_id = u.id;
