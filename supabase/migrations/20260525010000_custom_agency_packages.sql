-- Migration to support custom minute allocations and package pricing for agencies and subagencies

-- 1. Add custom minutes and custom price columns to public.agency_access_grants table
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS starter_custom_minutes INTEGER;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS starter_custom_price NUMERIC;

ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS pro_custom_minutes INTEGER;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS pro_custom_price NUMERIC;

ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS ultra_custom_minutes INTEGER;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS ultra_custom_price NUMERIC;
