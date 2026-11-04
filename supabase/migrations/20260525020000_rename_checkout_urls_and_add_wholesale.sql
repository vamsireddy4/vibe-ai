-- Migration to rename custom_checkout_url_starter/pro/ultra to checkout_url_starter/pro/ultra and ensure wholesale_rate_per_minute column exists
DO $$
BEGIN
  -- 1. Add wholesale_rate_per_minute if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='wholesale_rate_per_minute'
  ) THEN
    ALTER TABLE public.agency_access_grants ADD COLUMN wholesale_rate_per_minute NUMERIC NOT NULL DEFAULT 0.10;
  END IF;

  -- 2. Rename custom_checkout_url_starter if it exists and checkout_url_starter does not
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='custom_checkout_url_starter'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='checkout_url_starter'
  ) THEN
    ALTER TABLE public.agency_access_grants RENAME COLUMN custom_checkout_url_starter TO checkout_url_starter;
  END IF;

  -- 3. Rename custom_checkout_url_pro if it exists and checkout_url_pro does not
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='custom_checkout_url_pro'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='checkout_url_pro'
  ) THEN
    ALTER TABLE public.agency_access_grants RENAME COLUMN custom_checkout_url_pro TO checkout_url_pro;
  END IF;

  -- 4. Rename custom_checkout_url_ultra if it exists and checkout_url_ultra does not
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='custom_checkout_url_ultra'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='checkout_url_ultra'
  ) THEN
    ALTER TABLE public.agency_access_grants RENAME COLUMN custom_checkout_url_ultra TO checkout_url_ultra;
  END IF;

  -- 5. If neither exists, add checkout_url_starter, checkout_url_pro, checkout_url_ultra
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='checkout_url_starter'
  ) THEN
    ALTER TABLE public.agency_access_grants ADD COLUMN checkout_url_starter TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='checkout_url_pro'
  ) THEN
    ALTER TABLE public.agency_access_grants ADD COLUMN checkout_url_pro TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='agency_access_grants' AND column_name='checkout_url_ultra'
  ) THEN
    ALTER TABLE public.agency_access_grants ADD COLUMN checkout_url_ultra TEXT;
  END IF;

END $$;

-- 6. Drop and recreate the CHECK constraint to verify that client rate is at least wholesale rate
ALTER TABLE public.agency_access_grants DROP CONSTRAINT IF EXISTS chk_client_rate_above_cost;
ALTER TABLE public.agency_access_grants ADD CONSTRAINT chk_client_rate_above_cost CHECK (client_rate_per_minute >= wholesale_rate_per_minute);
