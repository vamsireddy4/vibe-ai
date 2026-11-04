-- 1. Add pricing and checkout configuration columns to public.agency_access_grants
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS client_rate_per_minute NUMERIC NOT NULL DEFAULT 0.15;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS custom_checkout_url TEXT;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS payment_instruction TEXT;

-- 2. Add Row Level Security (RLS) policies for select and update
-- Allow all logged-in authenticated users (clients) to read active agency details (pricing/checkout URL/instructions)
CREATE POLICY "Allow authenticated users to read active agency details"
ON public.agency_access_grants
FOR SELECT
USING (auth.role() = 'authenticated' AND is_active = true);

-- Allow active agencies to update their own settings directly from the frontend
CREATE POLICY "Allow active agencies to update their own settings"
ON public.agency_access_grants
FOR UPDATE
USING (LOWER(TRIM(email)) = LOWER(TRIM(auth.jwt()->>'email')) AND is_active = true)
WITH CHECK (LOWER(TRIM(email)) = LOWER(TRIM(auth.jwt()->>'email')) AND is_active = true);
