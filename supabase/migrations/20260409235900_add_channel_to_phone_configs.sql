ALTER TABLE public.phone_configs
ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'voice';

UPDATE public.phone_configs
SET channel = 'sms'
WHERE provider = 'telnyx'
  AND telnyx_public_key IS NOT NULL
  AND trim(telnyx_public_key) <> '';

ALTER TABLE public.phone_configs
DROP CONSTRAINT IF EXISTS phone_configs_channel_check;

ALTER TABLE public.phone_configs
ADD CONSTRAINT phone_configs_channel_check CHECK (channel IN ('voice', 'sms'));
