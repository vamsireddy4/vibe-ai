ALTER TABLE public.campaigns
ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN auto_retry_count INTEGER NOT NULL DEFAULT 2,
ADD COLUMN auto_retry_delay_minutes INTEGER NOT NULL DEFAULT 5,
ADD COLUMN auto_start_at TIMESTAMPTZ NULL,
ADD COLUMN automation_sheet_id TEXT NULL,
ADD COLUMN automation_sheet_url TEXT NULL,
ADD COLUMN parent_campaign_id UUID NULL REFERENCES public.campaigns(id) ON DELETE SET NULL;

ALTER TABLE public.call_outcomes
ADD COLUMN automation_retry_campaign_id UUID NULL REFERENCES public.campaigns(id) ON DELETE SET NULL,
ADD COLUMN automation_email_sent_at TIMESTAMPTZ NULL,
ADD COLUMN automation_sheet_synced_at TIMESTAMPTZ NULL;

ALTER TABLE public.campaigns
ADD CONSTRAINT campaigns_execution_mode_check
CHECK (execution_mode IN ('manual', 'automatic'));

ALTER TABLE public.campaigns
ADD CONSTRAINT campaigns_auto_retry_count_check
CHECK (auto_retry_count >= 0 AND auto_retry_count <= 2);

ALTER TABLE public.campaigns
ADD CONSTRAINT campaigns_auto_retry_delay_minutes_check
CHECK (auto_retry_delay_minutes >= 1);
