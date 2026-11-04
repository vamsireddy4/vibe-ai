ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS custom_crm_providers JSONB NOT NULL DEFAULT '[]'::jsonb;
