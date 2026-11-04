-- Migration to support hierarchical wholesale pricing and package-specific checkout links for agencies/subagencies

-- 1. Add package-specific custom checkout link columns to agency_access_grants table
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS checkout_url_starter TEXT;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS checkout_url_pro TEXT;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS checkout_url_ultra TEXT;

-- 2. Add wholesale_rate_per_minute column to assign a purchase/wholesale cost rate to each agency
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS wholesale_rate_per_minute NUMERIC NOT NULL DEFAULT 0.10;

-- 3. Add CHECK constraint ensuring that the agency's retail rate to their clients is at least their own cost
-- (This prevents setting retail client rate below their wholesale cost)
ALTER TABLE public.agency_access_grants ADD CONSTRAINT chk_client_rate_above_cost CHECK (client_rate_per_minute >= wholesale_rate_per_minute);
