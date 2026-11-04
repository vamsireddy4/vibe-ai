ALTER TABLE public.phone_configs
ADD COLUMN IF NOT EXISTS telnyx_public_key text;
