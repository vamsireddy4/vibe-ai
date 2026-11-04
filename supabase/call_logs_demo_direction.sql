-- Allow browser Demo Calls in call_logs (the app saves them with direction = 'demo' and shows
-- them under Call History -> Demo). The new project only allowed 'inbound' and 'outbound'.
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_direction_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_direction_check
  CHECK (direction IN ('inbound', 'outbound', 'demo'));
