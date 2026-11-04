ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS gmail_body_template TEXT;
