-- Add agency_email column to public.profiles table
ALTER TABLE public.profiles ADD COLUMN agency_email TEXT;

-- Create index on agency_email for faster filtering
CREATE INDEX IF NOT EXISTS profiles_agency_email_idx ON public.profiles(agency_email);
