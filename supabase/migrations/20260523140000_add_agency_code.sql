-- Create helper function to generate a random 6-character uppercase alphanumeric code
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

-- Add agency_code column to agency_access_grants table
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS agency_code TEXT UNIQUE;

-- Populate existing rows with random 6-digit codes
UPDATE public.agency_access_grants 
SET agency_code = public.generate_agency_code() 
WHERE agency_code IS NULL;
