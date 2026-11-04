-- Full schema for new project ewypjaksviupooxepfez: all 69 migrations in order.
-- Runs in one transaction: if anything fails, nothing is applied.
BEGIN;

-- ===== migrations/20260308232957_861f5fe2-e883-471c-aac4-b4f5fe75b403.sql =====

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Profiles table
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name TEXT,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- User roles
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;
CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT USING (auth.uid() = user_id);

-- Agents table
CREATE TABLE public.agents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT 'You are a helpful receptionist.',
  voice TEXT NOT NULL DEFAULT 'terrence',
  temperature NUMERIC(3,2) NOT NULL DEFAULT 0.7,
  first_speaker TEXT NOT NULL DEFAULT 'FIRST_SPEAKER_AGENT',
  language_hint TEXT DEFAULT 'en',
  max_duration INTEGER DEFAULT 300,
  is_active BOOLEAN NOT NULL DEFAULT true,
  phone_number_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own agents" ON public.agents FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own agents" ON public.agents FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own agents" ON public.agents FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own agents" ON public.agents FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Knowledge base items
CREATE TABLE public.knowledge_base_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'faq', 'document', 'website')),
  title TEXT NOT NULL,
  content TEXT,
  file_path TEXT,
  website_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.knowledge_base_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own kb items" ON public.knowledge_base_items FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own kb items" ON public.knowledge_base_items FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own kb items" ON public.knowledge_base_items FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own kb items" ON public.knowledge_base_items FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER update_kb_items_updated_at BEFORE UPDATE ON public.knowledge_base_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Phone configs (Twilio credentials per user)
CREATE TABLE public.phone_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  twilio_account_sid TEXT NOT NULL,
  twilio_auth_token TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  friendly_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.phone_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own phone configs" ON public.phone_configs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own phone configs" ON public.phone_configs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own phone configs" ON public.phone_configs FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own phone configs" ON public.phone_configs FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER update_phone_configs_updated_at BEFORE UPDATE ON public.phone_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Add FK from agents to phone_configs
ALTER TABLE public.agents ADD CONSTRAINT agents_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES public.phone_configs(id) ON DELETE SET NULL;

-- Call logs
CREATE TABLE public.call_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  caller_number TEXT,
  recipient_number TEXT,
  twilio_call_sid TEXT,
  ultravox_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'initiated',
  duration INTEGER,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ended_at TIMESTAMP WITH TIME ZONE,
  transcript JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own call logs" ON public.call_logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own call logs" ON public.call_logs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own call logs" ON public.call_logs FOR UPDATE USING (auth.uid() = user_id);

-- Storage bucket for documents
INSERT INTO storage.buckets (id, name, public) VALUES ('knowledge-documents', 'knowledge-documents', false);
CREATE POLICY "Users can upload own documents" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'knowledge-documents' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can view own documents" ON storage.objects FOR SELECT USING (bucket_id = 'knowledge-documents' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can delete own documents" ON storage.objects FOR DELETE USING (bucket_id = 'knowledge-documents' AND auth.uid()::text = (storage.foldername(name))[1]);


-- ===== migrations/20260310113411_4e0278e2-7bd1-46f4-a66d-242d20c1bc03.sql =====

-- Campaigns table (one per venue per round)
CREATE TABLE public.campaigns (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  venue_name text NOT NULL,
  venue_location text,
  start_date date,
  end_date date,
  times text,
  age_range text,
  round integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  booking_target integer,
  twilio_phone_number text,
  elevenlabs_campaign_id text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Contacts table (cleaned contacts per campaign)
CREATE TABLE public.contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE NOT NULL,
  phone_number text NOT NULL,
  first_name text NOT NULL,
  child_names text,
  venue_name text,
  venue_location text,
  start_date text,
  end_date text,
  times text,
  age_range text,
  sheet_reference text,
  language text DEFAULT 'en',
  voice_id text,
  first_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Call outcomes table
CREATE TABLE public.call_outcomes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE NOT NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  phone_number text NOT NULL,
  parent_name text,
  child_names text,
  venue_name text,
  outcome text NOT NULL DEFAULT 'PENDING',
  transcript text,
  summary text,
  attempt_number integer NOT NULL DEFAULT 1,
  call_timestamp timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Global do-not-call list
CREATE TABLE public.do_not_call (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  phone_number text NOT NULL,
  reason text NOT NULL,
  parent_name text,
  venue_name text,
  added_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.do_not_call ENABLE ROW LEVEL SECURITY;

-- Campaigns RLS
CREATE POLICY "Users can view own campaigns" ON public.campaigns FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own campaigns" ON public.campaigns FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own campaigns" ON public.campaigns FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own campaigns" ON public.campaigns FOR DELETE USING (auth.uid() = user_id);

-- Contacts RLS
CREATE POLICY "Users can view own contacts" ON public.contacts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own contacts" ON public.contacts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own contacts" ON public.contacts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own contacts" ON public.contacts FOR DELETE USING (auth.uid() = user_id);

-- Call outcomes RLS
CREATE POLICY "Users can view own outcomes" ON public.call_outcomes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own outcomes" ON public.call_outcomes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own outcomes" ON public.call_outcomes FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own outcomes" ON public.call_outcomes FOR DELETE USING (auth.uid() = user_id);

-- Do not call RLS
CREATE POLICY "Users can view own dnc" ON public.do_not_call FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own dnc" ON public.do_not_call FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own dnc" ON public.do_not_call FOR DELETE USING (auth.uid() = user_id);

-- Updated_at triggers
CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ===== migrations/20260310124318_deb99926-5f07-4303-aa97-9fdc1835bfbb.sql =====
ALTER TABLE public.agents ADD COLUMN model text NOT NULL DEFAULT 'fixie-ai/ultravox-v0.7';

-- ===== migrations/20260310125631_3a13a3f3-8794-455c-a165-0cd1369c651d.sql =====

-- Webhooks table: per-agent webhook configurations
CREATE TABLE public.webhooks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID REFERENCES public.agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{"call.completed"}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  secret TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own webhooks" ON public.webhooks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own webhooks" ON public.webhooks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own webhooks" ON public.webhooks FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own webhooks" ON public.webhooks FOR DELETE USING (auth.uid() = user_id);

-- Scheduled calls table: calendar-based call scheduling
CREATE TABLE public.scheduled_calls (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  recipient_number TEXT NOT NULL,
  recipient_name TEXT,
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.scheduled_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own scheduled calls" ON public.scheduled_calls FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own scheduled calls" ON public.scheduled_calls FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own scheduled calls" ON public.scheduled_calls FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own scheduled calls" ON public.scheduled_calls FOR DELETE USING (auth.uid() = user_id);

-- Agent tools table: custom tools the AI agent can invoke mid-call
CREATE TABLE public.agent_tools (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID REFERENCES public.agents(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  tool_type TEXT NOT NULL DEFAULT 'http',
  http_method TEXT NOT NULL DEFAULT 'POST',
  http_url TEXT NOT NULL,
  http_headers JSONB DEFAULT '{}',
  http_body_template JSONB DEFAULT '{}',
  parameters JSONB DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own agent tools" ON public.agent_tools FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own agent tools" ON public.agent_tools FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own agent tools" ON public.agent_tools FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own agent tools" ON public.agent_tools FOR DELETE USING (auth.uid() = user_id);


-- ===== migrations/20260310130449_d87e68d1-9910-4780-ac0e-b99491c48506.sql =====

-- Calendar integrations table: stores user calendar provider credentials
CREATE TABLE public.calendar_integrations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL, -- 'google_calendar', 'cal_com', 'gohighlevel'
  display_name TEXT NOT NULL DEFAULT '',
  api_key TEXT, -- For Cal.com and GoHighLevel
  refresh_token TEXT, -- For Google Calendar OAuth
  access_token TEXT, -- For Google Calendar OAuth
  token_expires_at TIMESTAMP WITH TIME ZONE,
  calendar_id TEXT, -- Specific calendar/sub-account ID
  is_active BOOLEAN NOT NULL DEFAULT true,
  config JSONB DEFAULT '{}', -- Provider-specific config (e.g. default event duration, location)
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

ALTER TABLE public.calendar_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own calendar integrations" ON public.calendar_integrations FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own calendar integrations" ON public.calendar_integrations FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own calendar integrations" ON public.calendar_integrations FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own calendar integrations" ON public.calendar_integrations FOR DELETE USING (auth.uid() = user_id);


-- ===== migrations/20260310132411_a802fc70-6091-40b8-be4f-68860ca8a7df.sql =====

ALTER TABLE public.phone_configs ADD COLUMN provider text NOT NULL DEFAULT 'twilio';
ALTER TABLE public.phone_configs ALTER COLUMN twilio_account_sid DROP NOT NULL;
ALTER TABLE public.phone_configs ALTER COLUMN twilio_auth_token DROP NOT NULL;
ALTER TABLE public.phone_configs ADD COLUMN telnyx_api_key text;
ALTER TABLE public.phone_configs ADD COLUMN telnyx_connection_id text;


-- ===== migrations/20260310173252_70d3dc3b-cdbc-4ded-9c03-2b8a4686d3e6.sql =====

ALTER TABLE public.campaigns 
  ADD COLUMN IF NOT EXISTS phone_config_id uuid REFERENCES public.phone_configs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delay_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS calls_made integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_contacts integer NOT NULL DEFAULT 0;


-- ===== migrations/20260310173421_c2cd394f-1573-4f06-8cce-1735e755b6f8.sql =====

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


-- ===== migrations/20260310181354_4d871a0c-a372-4b6e-9fe1-1669f35527f8.sql =====
ALTER TABLE public.agents ADD COLUMN ai_provider text NOT NULL DEFAULT 'ultravox';

-- ===== migrations/20260311065246_c466b2f5-3ac2-4d93-a820-61e7b2c0b5b2.sql =====
UPDATE agents SET model = 'gemini-2.5-flash-native-audio-preview-12-2025' WHERE ai_provider = 'gemini' AND model IN ('gemini-2.0-flash-live-001', 'gemini-2.0-flash-exp');

-- ===== migrations/20260311071241_f218fdf1-6a91-4726-8a81-8b9d4bee16b9.sql =====
UPDATE agents SET model = 'gemini-2.5-flash-preview-native-audio-dialog' WHERE ai_provider = 'gemini';

-- ===== migrations/20260311073531_54f4852e-c73d-43c2-9c8b-3ad7ddc5dc3a.sql =====
UPDATE public.agents SET model = 'gemini-2.5-flash-native-audio-preview-12-2025' WHERE model IN ('gemini-2.5-flash-preview-native-audio-dialog', 'gemini-2.0-flash-live-001');

-- ===== migrations/20260311074450_ca93804e-55c0-4a28-b594-d85a8b1ff3b8.sql =====
UPDATE public.agents SET voice = 'Kore' WHERE voice = 'Sindhu';

-- ===== migrations/20260311112545_85d3353a-1264-48e9-8e3c-92467ab89e1d.sql =====
ALTER TABLE public.contacts ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb;

-- ===== migrations/20260312160902_a984ef39-125a-45ea-aacb-e179c3f187cf.sql =====
CREATE TABLE public.telnyx_call_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_control_id TEXT NOT NULL UNIQUE,
  join_url TEXT NOT NULL,
  telnyx_api_key TEXT NOT NULL,
  agent_id UUID,
  user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-cleanup old records (older than 1 hour)
CREATE INDEX idx_telnyx_call_state_created ON telnyx_call_state(created_at);

-- RLS - service role only (edge functions use service key)
ALTER TABLE public.telnyx_call_state ENABLE ROW LEVEL SECURITY;

-- ===== migrations/20260312160929_b5b731dc-b6ca-45e6-aa75-326f6d0bf538.sql =====
-- Only service role needs access to this table (edge functions)
-- Add a deny-all policy since no client access is needed
CREATE POLICY "No direct access" ON public.telnyx_call_state FOR ALL USING (false);

-- ===== migrations/20260312171156_07866ede-17c0-425d-9789-9ac2b0f1f5d0.sql =====
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_logs;

-- ===== migrations/20260312172106_99bf1834-a5e1-45b3-807a-7b0321e9b415.sql =====
ALTER TABLE public.call_logs ADD COLUMN summary text DEFAULT NULL;

-- ===== migrations/20260312174136_69fa81ba-0cf2-4e53-b2d3-4a1806ca98c8.sql =====
ALTER PUBLICATION supabase_realtime ADD TABLE public.agents;
ALTER PUBLICATION supabase_realtime ADD TABLE public.phone_configs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.knowledge_base_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.webhooks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.scheduled_calls;
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_outcomes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_tools;
ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_integrations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.campaigns;
ALTER PUBLICATION supabase_realtime ADD TABLE public.contacts;

-- ===== migrations/20260313105031_d0bb4cae-54f4-46f3-b8c9-a9a503812734.sql =====
ALTER TABLE public.knowledge_base_items ADD COLUMN processing_status text DEFAULT 'pending';

-- ===== migrations/20260313135955_bdca7ef6-8d61-4bf7-952a-a5b239b9b0d4.sql =====

CREATE TABLE public.appointment_tools (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  calendar_integration_id UUID REFERENCES public.calendar_integrations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  business_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  appointment_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.appointment_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own appointment tools" ON public.appointment_tools FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own appointment tools" ON public.appointment_tools FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own appointment tools" ON public.appointment_tools FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own appointment tools" ON public.appointment_tools FOR DELETE USING (auth.uid() = user_id);


-- ===== migrations/20260313141952_f214b040-0347-49e2-9950-7cc05c60ba0a.sql =====
ALTER TABLE public.agents ADD COLUMN ultravox_agent_id text DEFAULT NULL;

-- ===== migrations/20260313151513_b2c7abd8-8669-42cb-916d-675129544413.sql =====

CREATE TABLE public.call_forwarding_numbers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  phone_number TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.call_forwarding_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own forwarding numbers" ON public.call_forwarding_numbers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own forwarding numbers" ON public.call_forwarding_numbers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own forwarding numbers" ON public.call_forwarding_numbers FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own forwarding numbers" ON public.call_forwarding_numbers FOR DELETE USING (auth.uid() = user_id);


-- ===== migrations/20260313172020_07a8b3da-6ffa-478b-a99a-894cc346c076.sql =====
ALTER TABLE public.call_forwarding_numbers ADD COLUMN priority integer NOT NULL DEFAULT 0;

-- ===== migrations/20260316190000_add_logo_urls.sql =====
ALTER TABLE public.phone_configs
ADD COLUMN IF NOT EXISTS logo_url text;

ALTER TABLE public.calendar_integrations
ADD COLUMN IF NOT EXISTS logo_url text;


-- ===== migrations/20260317120000_add_onboarding_completed_to_profiles.sql =====
alter table public.profiles
add column if not exists onboarding_completed boolean not null default false;

update public.profiles
set onboarding_completed = true
where onboarding_completed = false;


-- ===== migrations/20260317130000_add_gemini_key_to_profiles.sql =====
ALTER TABLE public.profiles ADD COLUMN gemini_api_key TEXT;


-- ===== migrations/20260318123204_set_onboarding_default_false.sql =====
ALTER TABLE public.profiles ALTER COLUMN onboarding_completed SET DEFAULT false; UPDATE public.profiles SET onboarding_completed = false WHERE onboarding_completed IS NULL;


-- ===== migrations/20260318154500_add_analysis_model_to_profiles.sql =====
ALTER TABLE public.profiles ADD COLUMN analysis_model TEXT DEFAULT 'gemini';


-- ===== migrations/20260319123000_add_campaign_phone_rotation_and_inbound_mapping.sql =====
ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS enable_number_locking BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.phone_configs
ADD COLUMN IF NOT EXISTS inbound_agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.campaign_phone_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  phone_config_id UUID NOT NULL REFERENCES public.phone_configs(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, phone_config_id)
);

ALTER TABLE public.campaign_phone_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own campaign phone configs"
ON public.campaign_phone_configs
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create own campaign phone configs"
ON public.campaign_phone_configs
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own campaign phone configs"
ON public.campaign_phone_configs
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own campaign phone configs"
ON public.campaign_phone_configs
FOR DELETE
USING (auth.uid() = user_id);

INSERT INTO public.campaign_phone_configs (user_id, campaign_id, phone_config_id, sort_order)
SELECT c.user_id, c.id, c.phone_config_id, 0
FROM public.campaigns c
WHERE c.phone_config_id IS NOT NULL
ON CONFLICT (campaign_id, phone_config_id) DO NOTHING;


-- ===== migrations/20260320110000_add_minute_balances_and_billing.sql =====
create table if not exists public.user_minute_balances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  available_seconds integer not null default 0 check (available_seconds >= 0),
  enterprise_rate_per_minute numeric(10, 4),
  last_enterprise_amount numeric(10, 2),
  last_enterprise_minutes integer,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.user_minute_balances enable row level security;

create policy "Users can view own minute balance"
on public.user_minute_balances
for select
using (auth.uid() = user_id);

create trigger update_user_minute_balances_updated_at
before update on public.user_minute_balances
for each row execute function public.update_updated_at_column();

create table if not exists public.minute_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  call_log_id uuid references public.call_logs(id) on delete set null,
  kind text not null check (kind in ('signup_credit', 'admin_credit', 'demo_deduction', 'live_deduction')),
  source text not null,
  seconds_delta integer not null,
  rate_per_minute numeric(10, 4),
  amount numeric(10, 2),
  notes text,
  created_at timestamp with time zone not null default now()
);

alter table public.minute_transactions enable row level security;

create policy "Users can view own minute transactions"
on public.minute_transactions
for select
using (auth.uid() = user_id);

alter table public.call_logs
  add column if not exists billing_status text not null default 'pending',
  add column if not exists billing_source text,
  add column if not exists billed_seconds integer,
  add column if not exists billed_minutes integer,
  add column if not exists billed_rate_per_minute numeric(10, 4),
  add column if not exists billed_amount numeric(10, 2);

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');

  insert into public.user_minute_balances (
    user_id,
    available_seconds,
    enterprise_rate_per_minute,
    last_enterprise_amount,
    last_enterprise_minutes
  )
  values (
    new.id,
    300,
    0.10,
    0,
    5
  )
  on conflict (user_id) do nothing;

  insert into public.minute_transactions (
    user_id,
    kind,
    source,
    seconds_delta,
    rate_per_minute,
    amount,
    notes
  )
  values (
    new.id,
    'signup_credit',
    'free',
    300,
    0.10,
    0,
    'Initial free signup credit'
  );

  return new;
end;
$$ language plpgsql security definer set search_path = public;

insert into public.user_minute_balances (
  user_id,
  available_seconds,
  enterprise_rate_per_minute,
  last_enterprise_amount,
  last_enterprise_minutes
)
select
  p.user_id,
  300,
  0.10,
  0,
  5
from public.profiles p
left join public.user_minute_balances b on b.user_id = p.user_id
where b.user_id is null;

insert into public.minute_transactions (
  user_id,
  kind,
  source,
  seconds_delta,
  rate_per_minute,
  amount,
  notes
)
select
  p.user_id,
  'signup_credit',
  'free',
  300,
  0.10,
  0,
  'Backfilled free signup credit'
from public.profiles p
left join public.minute_transactions t
  on t.user_id = p.user_id
 and t.kind = 'signup_credit'
where t.id is null;


-- ===== migrations/20260320233000_add_user_minute_balances_to_realtime.sql =====
alter publication supabase_realtime add table public.user_minute_balances;


-- ===== migrations/20260329004500_add_appointment_bookings.sql =====
CREATE TABLE public.appointment_bookings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  appointment_tool_id UUID REFERENCES public.appointment_tools(id) ON DELETE SET NULL,
  calendar_integration_id UUID REFERENCES public.calendar_integrations(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  calendar_name TEXT,
  provider_booking_id TEXT,
  title TEXT,
  booked_for_name TEXT NOT NULL,
  booked_for_email TEXT,
  booked_for_phone TEXT,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'booked',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX appointment_bookings_agent_id_idx
  ON public.appointment_bookings(agent_id, start_time);

CREATE UNIQUE INDEX appointment_bookings_provider_booking_id_idx
  ON public.appointment_bookings(provider, provider_booking_id)
  WHERE provider_booking_id IS NOT NULL;

ALTER TABLE public.appointment_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own appointment bookings"
  ON public.appointment_bookings
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own appointment bookings"
  ON public.appointment_bookings
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own appointment bookings"
  ON public.appointment_bookings
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own appointment bookings"
  ON public.appointment_bookings
  FOR DELETE
  USING (auth.uid() = user_id);


-- ===== migrations/20260331184500_add_agent_gmail_body_template.sql =====
ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS gmail_body_template TEXT;


-- ===== migrations/20260401143000_add_xpay_payment_events.sql =====
alter table public.minute_transactions
  drop constraint if exists minute_transactions_kind_check;

alter table public.minute_transactions
  add constraint minute_transactions_kind_check
  check (kind in ('signup_credit', 'admin_credit', 'demo_deduction', 'live_deduction', 'direct_purchase'));

create table if not exists public.xpay_payment_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique,
  event_type text not null,
  intent_id text,
  subscription_id text,
  customer_email text,
  amount numeric(10, 2),
  currency text,
  plan_name text,
  user_id uuid references auth.users(id) on delete set null,
  minutes_credited integer not null default 0,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);


-- ===== migrations/20260401162000_add_campaign_automation_fields.sql =====
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


-- ===== migrations/20260403113000_add_agent_use_google_docs.sql =====
ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS use_google_docs BOOLEAN NOT NULL DEFAULT FALSE;


-- ===== migrations/20260403121000_add_agent_custom_crm_providers.sql =====
ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS custom_crm_providers JSONB NOT NULL DEFAULT '[]'::jsonb;


-- ===== migrations/20260406184500_add_call_recordings.sql =====
-- Placeholder migration restored to match remote history.
-- This migration version already exists on the linked Supabase project.


-- ===== migrations/20260409161000_add_sms_templates.sql =====
create table if not exists public.sms_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text not null,
  name text not null,
  category text not null,
  message text not null,
  linked_tags jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists sms_templates_user_id_idx on public.sms_templates(user_id);
create index if not exists sms_templates_user_email_idx on public.sms_templates(user_email);
create index if not exists sms_templates_created_at_idx on public.sms_templates(created_at desc);

alter table public.sms_templates enable row level security;

create policy "Users can view own sms templates"
on public.sms_templates
for select
using (auth.uid() = user_id);

create policy "Users can create own sms templates"
on public.sms_templates
for insert
with check (auth.uid() = user_id);

create policy "Users can update own sms templates"
on public.sms_templates
for update
using (auth.uid() = user_id);

create policy "Users can delete own sms templates"
on public.sms_templates
for delete
using (auth.uid() = user_id);

create trigger update_sms_templates_updated_at
before update on public.sms_templates
for each row execute function update_updated_at_column();

alter publication supabase_realtime add table public.sms_templates;


-- ===== migrations/20260409170000_add_sms_campaigns.sql =====
create table if not exists public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text not null,
  name text not null,
  status text not null default 'draft',
  total_contacts integer not null default 0,
  extracted_contacts jsonb not null default '[]'::jsonb,
  template_id uuid null references public.sms_templates(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists sms_campaigns_user_id_idx on public.sms_campaigns(user_id);
create index if not exists sms_campaigns_user_email_idx on public.sms_campaigns(user_email);
create index if not exists sms_campaigns_created_at_idx on public.sms_campaigns(created_at desc);

alter table public.sms_campaigns enable row level security;

create policy "Users can view own sms campaigns"
on public.sms_campaigns
for select
using (auth.uid() = user_id);

create policy "Users can create own sms campaigns"
on public.sms_campaigns
for insert
with check (auth.uid() = user_id);

create policy "Users can update own sms campaigns"
on public.sms_campaigns
for update
using (auth.uid() = user_id);

create policy "Users can delete own sms campaigns"
on public.sms_campaigns
for delete
using (auth.uid() = user_id);

create trigger update_sms_campaigns_updated_at
before update on public.sms_campaigns
for each row execute function update_updated_at_column();

alter publication supabase_realtime add table public.sms_campaigns;


-- ===== migrations/20260409183000_add_sms_completed_campaigns.sql =====
create table if not exists public.sms_completed_campaigns (
  id uuid primary key default gen_random_uuid(),
  source_campaign_id uuid null references public.sms_campaigns(id) on delete set null,
  user_id uuid not null,
  user_email text not null,
  name text not null,
  template_id uuid null references public.sms_templates(id) on delete set null,
  template_name text not null,
  phone_config_id uuid null references public.phone_configs(id) on delete set null,
  sender_phone_number text not null,
  status text not null default 'completed',
  total_contacts integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  selected_contacts jsonb not null default '[]'::jsonb,
  outcomes jsonb not null default '[]'::jsonb,
  started_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists sms_completed_campaigns_user_id_idx on public.sms_completed_campaigns(user_id);
create index if not exists sms_completed_campaigns_user_email_idx on public.sms_completed_campaigns(user_email);
create index if not exists sms_completed_campaigns_source_campaign_id_idx on public.sms_completed_campaigns(source_campaign_id);
create index if not exists sms_completed_campaigns_created_at_idx on public.sms_completed_campaigns(created_at desc);

alter table public.sms_completed_campaigns enable row level security;

create policy "Users can view own sms completed campaigns"
on public.sms_completed_campaigns
for select
using (auth.uid() = user_id);

create policy "Users can create own sms completed campaigns"
on public.sms_completed_campaigns
for insert
with check (auth.uid() = user_id);

create policy "Users can update own sms completed campaigns"
on public.sms_completed_campaigns
for update
using (auth.uid() = user_id);

create policy "Users can delete own sms completed campaigns"
on public.sms_completed_campaigns
for delete
using (auth.uid() = user_id);

create trigger update_sms_completed_campaigns_updated_at
before update on public.sms_completed_campaigns
for each row execute function update_updated_at_column();

alter publication supabase_realtime add table public.sms_completed_campaigns;


-- ===== migrations/20260409234500_add_telnyx_public_key_to_phone_configs.sql =====
ALTER TABLE public.phone_configs
ADD COLUMN IF NOT EXISTS telnyx_public_key text;


-- ===== migrations/20260409235500_add_sms_inbox_tables.sql =====
CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customers_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_customers_user_id ON public.customers(user_id);

CREATE OR REPLACE FUNCTION public.update_customers_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_customers_updated_at ON public.customers;
CREATE TRIGGER update_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_customers_updated_at_column();

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'Users can view own customers'
  ) THEN
    CREATE POLICY "Users can view own customers" ON public.customers FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'Users can insert own customers'
  ) THEN
    CREATE POLICY "Users can insert own customers" ON public.customers FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'Users can update own customers'
  ) THEN
    CREATE POLICY "Users can update own customers" ON public.customers FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'Users can delete own customers'
  ) THEN
    CREATE POLICY "Users can delete own customers" ON public.customers FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.handle_new_user_customers()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.customers (user_id, customers_data)
  VALUES (NEW.id, '[]'::jsonb)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created_customers ON auth.users;
CREATE TRIGGER on_auth_user_created_customers
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_customers();

INSERT INTO public.customers (user_id, customers_data)
SELECT u.id, '[]'::jsonb
FROM auth.users u
LEFT JOIN public.customers c ON c.user_id = u.id
WHERE c.user_id IS NULL;

CREATE TABLE IF NOT EXISTS public.customer_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  customer_name text,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_message text,
  last_message_at timestamptz,
  unread_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_conversations_user ON public.customer_conversations(user_id);

CREATE OR REPLACE FUNCTION public.update_customer_conversations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_conversations_updated_at ON public.customer_conversations;
CREATE TRIGGER trg_customer_conversations_updated_at
  BEFORE UPDATE ON public.customer_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_customer_conversations_updated_at();

ALTER TABLE public.customer_conversations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_conversations' AND policyname = 'Users can view own conversations'
  ) THEN
    CREATE POLICY "Users can view own conversations" ON public.customer_conversations FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_conversations' AND policyname = 'Users can insert own conversations'
  ) THEN
    CREATE POLICY "Users can insert own conversations" ON public.customer_conversations FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_conversations' AND policyname = 'Users can update own conversations'
  ) THEN
    CREATE POLICY "Users can update own conversations" ON public.customer_conversations FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_conversations' AND policyname = 'Users can delete own conversations'
  ) THEN
    CREATE POLICY "Users can delete own conversations" ON public.customer_conversations FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_id text,
  occurred_at timestamptz,
  direction text,
  from_number text,
  to_number text,
  message_text text,
  message_id text,
  status text,
  processed boolean NOT NULL DEFAULT false,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  error_message text,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_event_type ON public.webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_message_id ON public.webhook_logs(message_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_from_number ON public.webhook_logs(from_number);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_to_number ON public.webhook_logs(to_number);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON public.webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_processed ON public.webhook_logs(processed);

ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'webhook_logs' AND policyname = 'Users can view own webhook logs'
  ) THEN
    CREATE POLICY "Users can view own webhook logs" ON public.webhook_logs FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;


-- ===== migrations/20260409235900_add_channel_to_phone_configs.sql =====
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


-- ===== migrations/20260410001500_add_sms_sender_config_to_phone_configs.sql =====
alter table public.phone_configs
  add column if not exists telnyx_messaging_profile_id text,
  add column if not exists sms_sender_type text,
  add column if not exists telnyx_alpha_sender_id text,
  add column if not exists telnyx_dlt_entity_id text,
  add column if not exists telnyx_dlt_template_id text;

update public.phone_configs
set sms_sender_type = coalesce(nullif(sms_sender_type, ''), case when channel = 'sms' then 'phone_number' else null end)
where channel = 'sms';

alter table public.phone_configs
  drop constraint if exists phone_configs_sms_sender_type_check;

alter table public.phone_configs
  add constraint phone_configs_sms_sender_type_check
  check (sms_sender_type is null or sms_sender_type in ('phone_number', 'alpha_sender'));


-- ===== migrations/20260418183000_add_training_sessions.sql =====
create table if not exists public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  persona_name text not null,
  persona_role text null,
  status text not null default 'completed' check (status in ('completed', 'in_progress', 'abandoned')),
  score integer null check (score is null or (score >= 0 and score <= 100)),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  talk_ratio numeric(5,2) null check (talk_ratio is null or (talk_ratio >= 0 and talk_ratio <= 100)),
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  transcript jsonb not null default '[]'::jsonb,
  skill_scores jsonb not null default '{}'::jsonb,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_sessions_user_id_idx
  on public.training_sessions(user_id);

create index if not exists training_sessions_started_at_idx
  on public.training_sessions(started_at desc);

create index if not exists training_sessions_completed_at_idx
  on public.training_sessions(completed_at desc);

alter table public.training_sessions enable row level security;

create policy "Users can view own training sessions"
on public.training_sessions
for select
using (auth.uid() = user_id);

create policy "Users can create own training sessions"
on public.training_sessions
for insert
with check (auth.uid() = user_id);

create policy "Users can update own training sessions"
on public.training_sessions
for update
using (auth.uid() = user_id);

create policy "Users can delete own training sessions"
on public.training_sessions
for delete
using (auth.uid() = user_id);

create trigger update_training_sessions_updated_at
before update on public.training_sessions
for each row execute function public.update_updated_at_column();

alter publication supabase_realtime add table public.training_sessions;


-- ===== migrations/20260421161000_add_training_agents.sql =====
create table if not exists public.training_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  role text not null,
  company_name text null,
  industry text not null,
  description text not null,
  tags jsonb not null default '[]'::jsonb,
  common_objections text null,
  call_type text not null default 'Cold Call',
  turn_mode text not null default 'Agent starts',
  difficulty text not null default 'Medium' check (difficulty in ('Easy', 'Medium', 'Hard')),
  system_prompt text not null,
  voice_name text null,
  voice_language text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_agents_user_id_idx
  on public.training_agents(user_id);

create index if not exists training_agents_created_at_idx
  on public.training_agents(created_at desc);

alter table public.training_agents enable row level security;

create policy "Users can view own training agents"
on public.training_agents
for select
using (auth.uid() = user_id);

create policy "Users can create own training agents"
on public.training_agents
for insert
with check (auth.uid() = user_id);

create policy "Users can update own training agents"
on public.training_agents
for update
using (auth.uid() = user_id);

create policy "Users can delete own training agents"
on public.training_agents
for delete
using (auth.uid() = user_id);

create trigger update_training_agents_updated_at
before update on public.training_agents
for each row execute function public.update_updated_at_column();

alter publication supabase_realtime add table public.training_agents;


-- ===== migrations/20260423003014_add_gmail_campaign_tables.sql =====
create table if not exists public.gmail_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text not null,
  name text not null,
  category text not null default 'email',
  message text not null,
  linked_tags jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists gmail_templates_user_id_idx on public.gmail_templates(user_id);
create index if not exists gmail_templates_user_email_idx on public.gmail_templates(user_email);
create index if not exists gmail_templates_created_at_idx on public.gmail_templates(created_at desc);

alter table public.gmail_templates enable row level security;

create policy "Users can view own gmail templates"
on public.gmail_templates
for select
using (auth.uid() = user_id);

create policy "Users can create own gmail templates"
on public.gmail_templates
for insert
with check (auth.uid() = user_id);

create policy "Users can update own gmail templates"
on public.gmail_templates
for update
using (auth.uid() = user_id);

create policy "Users can delete own gmail templates"
on public.gmail_templates
for delete
using (auth.uid() = user_id);

create trigger update_gmail_templates_updated_at
before update on public.gmail_templates
for each row execute function update_updated_at_column();

alter publication supabase_realtime add table public.gmail_templates;

create table if not exists public.gmail_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text not null,
  name text not null,
  status text not null default 'draft',
  total_contacts integer not null default 0,
  extracted_contacts jsonb not null default '[]'::jsonb,
  template_id uuid null references public.gmail_templates(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists gmail_campaigns_user_id_idx on public.gmail_campaigns(user_id);
create index if not exists gmail_campaigns_user_email_idx on public.gmail_campaigns(user_email);
create index if not exists gmail_campaigns_created_at_idx on public.gmail_campaigns(created_at desc);

alter table public.gmail_campaigns enable row level security;

create policy "Users can view own gmail campaigns"
on public.gmail_campaigns
for select
using (auth.uid() = user_id);

create policy "Users can create own gmail campaigns"
on public.gmail_campaigns
for insert
with check (auth.uid() = user_id);

create policy "Users can update own gmail campaigns"
on public.gmail_campaigns
for update
using (auth.uid() = user_id);

create policy "Users can delete own gmail campaigns"
on public.gmail_campaigns
for delete
using (auth.uid() = user_id);

create trigger update_gmail_campaigns_updated_at
before update on public.gmail_campaigns
for each row execute function update_updated_at_column();

alter publication supabase_realtime add table public.gmail_campaigns;

create table if not exists public.gmail_completed_campaigns (
  id uuid primary key default gen_random_uuid(),
  source_campaign_id uuid null references public.gmail_campaigns(id) on delete set null,
  user_id uuid not null,
  user_email text not null,
  name text not null,
  template_id uuid null references public.gmail_templates(id) on delete set null,
  template_name text not null,
  sender_email_address text not null default '',
  status text not null default 'completed',
  total_contacts integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  selected_contacts jsonb not null default '[]'::jsonb,
  outcomes jsonb not null default '[]'::jsonb,
  started_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists gmail_completed_campaigns_user_id_idx on public.gmail_completed_campaigns(user_id);
create index if not exists gmail_completed_campaigns_user_email_idx on public.gmail_completed_campaigns(user_email);
create index if not exists gmail_completed_campaigns_source_campaign_id_idx on public.gmail_completed_campaigns(source_campaign_id);
create index if not exists gmail_completed_campaigns_created_at_idx on public.gmail_completed_campaigns(created_at desc);

alter table public.gmail_completed_campaigns enable row level security;

create policy "Users can view own gmail completed campaigns"
on public.gmail_completed_campaigns
for select
using (auth.uid() = user_id);

create policy "Users can create own gmail completed campaigns"
on public.gmail_completed_campaigns
for insert
with check (auth.uid() = user_id);

create policy "Users can update own gmail completed campaigns"
on public.gmail_completed_campaigns
for update
using (auth.uid() = user_id);

create policy "Users can delete own gmail completed campaigns"
on public.gmail_completed_campaigns
for delete
using (auth.uid() = user_id);

create trigger update_gmail_completed_campaigns_updated_at
before update on public.gmail_completed_campaigns
for each row execute function update_updated_at_column();

alter publication supabase_realtime add table public.gmail_completed_campaigns;


-- ===== migrations/20260427150500_add_whatsapp_workspace_tables.sql =====
create or replace function public.generate_whatsapp_verify_token()
returns text
language sql
volatile
set search_path = public
as $$
  select lpad(((floor(random() * 1000000))::int)::text, 6, '0');
$$;

create table if not exists public.whatsapp_webhook_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  webhook_key uuid not null unique default gen_random_uuid(),
  verify_token text not null default public.generate_whatsapp_verify_token(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_api_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  meta_access_token text,
  meta_phone_number_id text,
  meta_business_account_id text,
  meta_app_id text,
  validated_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_auto_reply_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  is_enabled boolean not null default true,
  webhook_url text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_weekly_report_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  prompt text not null default '',
  tone text not null default 'Formal & Professional',
  language text not null default 'English',
  button_types text[] not null default array['Quick Reply']::text[],
  image_names text[] not null default array[]::text[],
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  phone_number text not null,
  email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (user_id, phone_number)
);

create table if not exists public.whatsapp_audiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  tag text not null default 'WhatsApp Segment',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_audience_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  audience_id uuid not null references public.whatsapp_audiences(id) on delete cascade,
  contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  unique (audience_id, contact_id)
);

create table if not exists public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  template_type text not null check (template_type in ('standard', 'carousel')),
  name text not null,
  normalized_name text not null,
  body text not null,
  category text not null default 'utility',
  language text not null default 'en_US',
  footer_text text not null default '',
  button_types text[] not null default array[]::text[],
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  audience_id uuid references public.whatsapp_audiences(id) on delete set null,
  template_id uuid references public.whatsapp_templates(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'failed')),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_name text not null,
  phone_number text not null,
  last_message_text text,
  last_message_at timestamp with time zone,
  unread_count integer not null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (user_id, phone_number)
);

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  provider_message_id text,
  status text not null default 'sent' check (status in ('sent', 'delivered', 'read', 'failed')),
  error_message text,
  raw_payload jsonb not null default '{}'::jsonb,
  sent_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now()
);

create table if not exists public.whatsapp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  webhook_config_id uuid not null references public.whatsapp_webhook_configs(id) on delete cascade,
  event_type text,
  payload jsonb not null,
  created_at timestamp with time zone not null default now()
);

alter table public.whatsapp_webhook_configs enable row level security;
alter table public.whatsapp_api_configs enable row level security;
alter table public.whatsapp_auto_reply_configs enable row level security;
alter table public.whatsapp_weekly_report_settings enable row level security;
alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_audiences enable row level security;
alter table public.whatsapp_audience_contacts enable row level security;
alter table public.whatsapp_templates enable row level security;
alter table public.whatsapp_campaigns enable row level security;
alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_webhook_events enable row level security;

drop policy if exists "Users can view own whatsapp webhook configs" on public.whatsapp_webhook_configs;
drop policy if exists "Users can insert own whatsapp webhook configs" on public.whatsapp_webhook_configs;
drop policy if exists "Users can update own whatsapp webhook configs" on public.whatsapp_webhook_configs;
create policy "Users can view own whatsapp webhook configs" on public.whatsapp_webhook_configs for select using (auth.uid() = user_id);
create policy "Users can insert own whatsapp webhook configs" on public.whatsapp_webhook_configs for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp webhook configs" on public.whatsapp_webhook_configs for update using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp api configs" on public.whatsapp_api_configs;
drop policy if exists "Users can insert own whatsapp api configs" on public.whatsapp_api_configs;
drop policy if exists "Users can update own whatsapp api configs" on public.whatsapp_api_configs;
create policy "Users can view own whatsapp api configs" on public.whatsapp_api_configs for select using (auth.uid() = user_id);
create policy "Users can insert own whatsapp api configs" on public.whatsapp_api_configs for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp api configs" on public.whatsapp_api_configs for update using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp auto reply configs" on public.whatsapp_auto_reply_configs;
drop policy if exists "Users can insert own whatsapp auto reply configs" on public.whatsapp_auto_reply_configs;
drop policy if exists "Users can update own whatsapp auto reply configs" on public.whatsapp_auto_reply_configs;
create policy "Users can view own whatsapp auto reply configs" on public.whatsapp_auto_reply_configs for select using (auth.uid() = user_id);
create policy "Users can insert own whatsapp auto reply configs" on public.whatsapp_auto_reply_configs for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp auto reply configs" on public.whatsapp_auto_reply_configs for update using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp weekly report settings" on public.whatsapp_weekly_report_settings;
drop policy if exists "Users can insert own whatsapp weekly report settings" on public.whatsapp_weekly_report_settings;
drop policy if exists "Users can update own whatsapp weekly report settings" on public.whatsapp_weekly_report_settings;
create policy "Users can view own whatsapp weekly report settings" on public.whatsapp_weekly_report_settings for select using (auth.uid() = user_id);
create policy "Users can insert own whatsapp weekly report settings" on public.whatsapp_weekly_report_settings for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp weekly report settings" on public.whatsapp_weekly_report_settings for update using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp contacts" on public.whatsapp_contacts;
drop policy if exists "Users can create own whatsapp contacts" on public.whatsapp_contacts;
drop policy if exists "Users can update own whatsapp contacts" on public.whatsapp_contacts;
drop policy if exists "Users can delete own whatsapp contacts" on public.whatsapp_contacts;
create policy "Users can view own whatsapp contacts" on public.whatsapp_contacts for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp contacts" on public.whatsapp_contacts for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp contacts" on public.whatsapp_contacts for update using (auth.uid() = user_id);
create policy "Users can delete own whatsapp contacts" on public.whatsapp_contacts for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp audiences" on public.whatsapp_audiences;
drop policy if exists "Users can create own whatsapp audiences" on public.whatsapp_audiences;
drop policy if exists "Users can update own whatsapp audiences" on public.whatsapp_audiences;
drop policy if exists "Users can delete own whatsapp audiences" on public.whatsapp_audiences;
create policy "Users can view own whatsapp audiences" on public.whatsapp_audiences for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp audiences" on public.whatsapp_audiences for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp audiences" on public.whatsapp_audiences for update using (auth.uid() = user_id);
create policy "Users can delete own whatsapp audiences" on public.whatsapp_audiences for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp audience contacts" on public.whatsapp_audience_contacts;
drop policy if exists "Users can create own whatsapp audience contacts" on public.whatsapp_audience_contacts;
drop policy if exists "Users can delete own whatsapp audience contacts" on public.whatsapp_audience_contacts;
create policy "Users can view own whatsapp audience contacts" on public.whatsapp_audience_contacts for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp audience contacts" on public.whatsapp_audience_contacts for insert with check (auth.uid() = user_id);
create policy "Users can delete own whatsapp audience contacts" on public.whatsapp_audience_contacts for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp templates" on public.whatsapp_templates;
drop policy if exists "Users can create own whatsapp templates" on public.whatsapp_templates;
drop policy if exists "Users can update own whatsapp templates" on public.whatsapp_templates;
drop policy if exists "Users can delete own whatsapp templates" on public.whatsapp_templates;
create policy "Users can view own whatsapp templates" on public.whatsapp_templates for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp templates" on public.whatsapp_templates for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp templates" on public.whatsapp_templates for update using (auth.uid() = user_id);
create policy "Users can delete own whatsapp templates" on public.whatsapp_templates for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp campaigns" on public.whatsapp_campaigns;
drop policy if exists "Users can create own whatsapp campaigns" on public.whatsapp_campaigns;
drop policy if exists "Users can update own whatsapp campaigns" on public.whatsapp_campaigns;
drop policy if exists "Users can delete own whatsapp campaigns" on public.whatsapp_campaigns;
create policy "Users can view own whatsapp campaigns" on public.whatsapp_campaigns for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp campaigns" on public.whatsapp_campaigns for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp campaigns" on public.whatsapp_campaigns for update using (auth.uid() = user_id);
create policy "Users can delete own whatsapp campaigns" on public.whatsapp_campaigns for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp conversations" on public.whatsapp_conversations;
drop policy if exists "Users can create own whatsapp conversations" on public.whatsapp_conversations;
drop policy if exists "Users can update own whatsapp conversations" on public.whatsapp_conversations;
drop policy if exists "Users can delete own whatsapp conversations" on public.whatsapp_conversations;
create policy "Users can view own whatsapp conversations" on public.whatsapp_conversations for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp conversations" on public.whatsapp_conversations for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp conversations" on public.whatsapp_conversations for update using (auth.uid() = user_id);
create policy "Users can delete own whatsapp conversations" on public.whatsapp_conversations for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp messages" on public.whatsapp_messages;
drop policy if exists "Users can create own whatsapp messages" on public.whatsapp_messages;
drop policy if exists "Users can update own whatsapp messages" on public.whatsapp_messages;
create policy "Users can view own whatsapp messages" on public.whatsapp_messages for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp messages" on public.whatsapp_messages for insert with check (auth.uid() = user_id);
create policy "Users can update own whatsapp messages" on public.whatsapp_messages for update using (auth.uid() = user_id);

drop policy if exists "Users can view own whatsapp webhook events" on public.whatsapp_webhook_events;
drop policy if exists "Users can create own whatsapp webhook events" on public.whatsapp_webhook_events;
create policy "Users can view own whatsapp webhook events" on public.whatsapp_webhook_events for select using (auth.uid() = user_id);
create policy "Users can create own whatsapp webhook events" on public.whatsapp_webhook_events for insert with check (auth.uid() = user_id);

drop trigger if exists update_whatsapp_webhook_configs_updated_at on public.whatsapp_webhook_configs;
drop trigger if exists update_whatsapp_api_configs_updated_at on public.whatsapp_api_configs;
drop trigger if exists update_whatsapp_auto_reply_configs_updated_at on public.whatsapp_auto_reply_configs;
drop trigger if exists update_whatsapp_weekly_report_settings_updated_at on public.whatsapp_weekly_report_settings;
drop trigger if exists update_whatsapp_contacts_updated_at on public.whatsapp_contacts;
drop trigger if exists update_whatsapp_audiences_updated_at on public.whatsapp_audiences;
drop trigger if exists update_whatsapp_templates_updated_at on public.whatsapp_templates;
drop trigger if exists update_whatsapp_campaigns_updated_at on public.whatsapp_campaigns;
drop trigger if exists update_whatsapp_conversations_updated_at on public.whatsapp_conversations;
create trigger update_whatsapp_webhook_configs_updated_at before update on public.whatsapp_webhook_configs for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_api_configs_updated_at before update on public.whatsapp_api_configs for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_auto_reply_configs_updated_at before update on public.whatsapp_auto_reply_configs for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_weekly_report_settings_updated_at before update on public.whatsapp_weekly_report_settings for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_contacts_updated_at before update on public.whatsapp_contacts for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_audiences_updated_at before update on public.whatsapp_audiences for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_templates_updated_at before update on public.whatsapp_templates for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_campaigns_updated_at before update on public.whatsapp_campaigns for each row execute function public.update_updated_at_column();
create trigger update_whatsapp_conversations_updated_at before update on public.whatsapp_conversations for each row execute function public.update_updated_at_column();

create index if not exists whatsapp_contacts_user_id_idx on public.whatsapp_contacts(user_id, created_at desc);
create index if not exists whatsapp_audiences_user_id_idx on public.whatsapp_audiences(user_id);
create index if not exists whatsapp_audience_contacts_user_id_idx on public.whatsapp_audience_contacts(user_id);
create index if not exists whatsapp_templates_user_id_idx on public.whatsapp_templates(user_id);
create index if not exists whatsapp_campaigns_user_id_idx on public.whatsapp_campaigns(user_id);
create index if not exists whatsapp_conversations_user_id_idx on public.whatsapp_conversations(user_id, last_message_at desc nulls last);
create index if not exists whatsapp_messages_conversation_id_idx on public.whatsapp_messages(conversation_id, sent_at asc);
create index if not exists whatsapp_messages_provider_message_id_idx on public.whatsapp_messages(provider_message_id);
create index if not exists whatsapp_webhook_events_user_id_idx on public.whatsapp_webhook_events(user_id, created_at desc);

do $$
begin
  alter publication supabase_realtime add table public.whatsapp_conversations;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.whatsapp_messages;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.whatsapp_campaigns;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.whatsapp_contacts;
exception when duplicate_object then null;
end $$;

insert into public.whatsapp_webhook_configs (user_id)
select p.user_id
from public.profiles p
join auth.users u on u.id = p.user_id
left join public.whatsapp_webhook_configs w on w.user_id = p.user_id
where w.user_id is null;

insert into public.whatsapp_api_configs (user_id)
select p.user_id
from public.profiles p
join auth.users u on u.id = p.user_id
left join public.whatsapp_api_configs c on c.user_id = p.user_id
where c.user_id is null;

insert into public.whatsapp_auto_reply_configs (user_id)
select p.user_id
from public.profiles p
join auth.users u on u.id = p.user_id
left join public.whatsapp_auto_reply_configs c on c.user_id = p.user_id
where c.user_id is null;

insert into public.whatsapp_weekly_report_settings (user_id)
select p.user_id
from public.profiles p
join auth.users u on u.id = p.user_id
left join public.whatsapp_weekly_report_settings s on s.user_id = p.user_id
where s.user_id is null;

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (user_id) do nothing;

  insert into public.user_minute_balances (
    user_id,
    available_seconds,
    enterprise_rate_per_minute,
    last_enterprise_amount,
    last_enterprise_minutes
  )
  values (
    new.id,
    300,
    0.10,
    0,
    5
  )
  on conflict (user_id) do nothing;

  insert into public.minute_transactions (
    user_id,
    kind,
    source,
    seconds_delta,
    rate_per_minute,
    amount,
    notes
  )
  values (
    new.id,
    'signup_credit',
    'free',
    300,
    0.10,
    0,
    'Initial free signup credit'
  );

  insert into public.whatsapp_webhook_configs (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.whatsapp_api_configs (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.whatsapp_auto_reply_configs (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.whatsapp_weekly_report_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$ language plpgsql security definer set search_path = public;


-- ===== migrations/20260427212000_expand_whatsapp_template_schema.sql =====
alter table public.whatsapp_templates
  add column if not exists header_enabled boolean not null default false,
  add column if not exists header_type text,
  add column if not exists header_text text not null default '',
  add column if not exists footer_enabled boolean not null default false,
  add column if not exists buttons_enabled boolean not null default false,
  add column if not exists buttons jsonb not null default '[]'::jsonb,
  add column if not exists parameter_tokens text[] not null default array[]::text[],
  add column if not exists carousel_cards jsonb not null default '[]'::jsonb,
  add column if not exists meta_template_id text,
  add column if not exists meta_status text not null default 'draft';

alter table public.whatsapp_templates
  drop constraint if exists whatsapp_templates_header_type_check;

alter table public.whatsapp_templates
  add constraint whatsapp_templates_header_type_check
  check (header_type is null or header_type in ('text', 'image', 'video', 'document'));

alter table public.whatsapp_templates
  drop constraint if exists whatsapp_templates_meta_status_check;

alter table public.whatsapp_templates
  add constraint whatsapp_templates_meta_status_check
  check (meta_status in ('draft', 'pending_review', 'approved', 'rejected', 'paused'));

create unique index if not exists whatsapp_templates_user_normalized_language_idx
  on public.whatsapp_templates(user_id, normalized_name, language);

update public.whatsapp_templates
set
  footer_enabled = coalesce(length(nullif(trim(footer_text), '')) > 0, false),
  buttons_enabled = coalesce(array_length(button_types, 1), 0) > 0,
  buttons = case
    when coalesce(array_length(button_types, 1), 0) = 0 then '[]'::jsonb
    else (
      select jsonb_agg(
        jsonb_build_object(
          'type', button_type,
          'label',
          case button_type
            when 'visit_website' then 'Visit Website'
            when 'call_phone' then 'Call Phone'
            when 'quick_message' then 'Quick Message'
            else initcap(replace(button_type, '_', ' '))
          end
        )
      )
      from unnest(button_types) as button_type
    )
  end,
  parameter_tokens = coalesce(
    (
      select array_agg(distinct matches[1])
      from regexp_matches(body, '\{\{\s*([^}]+?)\s*\}\}', 'g') as matches
    ),
    array[]::text[]
  )
where true;


-- ===== migrations/20260427213500_create_templates_table.sql =====
create table if not exists public."Templates" (
  id uuid not null default gen_random_uuid(),
  user_email text not null,
  template_name text not null,
  template_type text null default 'text'::text,
  content text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  category text null default 'UTILITY'::text,
  language text null default 'en_US'::text,
  status text null default 'pending'::text,
  meta_template_id text null,
  body_text text null,
  carousel_data jsonb null,
  constraint Templates_pkey primary key (id)
) TABLESPACE pg_default;

create index if not exists idx_templates_user_email
on public."Templates" using btree (user_email) TABLESPACE pg_default;

create index if not exists idx_templates_type
on public."Templates" using btree (template_type) TABLESPACE pg_default;

create unique index if not exists idx_templates_user_email_name
on public."Templates" using btree (user_email, template_name) TABLESPACE pg_default;

create index if not exists idx_templates_status
on public."Templates" using btree (status) TABLESPACE pg_default;

drop trigger if exists update_templates_updated_at on public."Templates";

create trigger update_templates_updated_at
before update on public."Templates"
for each row
execute function public.update_updated_at_column();

alter table public."Templates" enable row level security;

drop policy if exists "Users can view own Templates" on public."Templates";
drop policy if exists "Users can insert own Templates" on public."Templates";
drop policy if exists "Users can update own Templates" on public."Templates";
drop policy if exists "Users can delete own Templates" on public."Templates";

create policy "Users can view own Templates"
on public."Templates"
for select
using (auth.jwt() ->> 'email' = user_email);

create policy "Users can insert own Templates"
on public."Templates"
for insert
with check (auth.jwt() ->> 'email' = user_email);

create policy "Users can update own Templates"
on public."Templates"
for update
using (auth.jwt() ->> 'email' = user_email);

create policy "Users can delete own Templates"
on public."Templates"
for delete
using (auth.jwt() ->> 'email' = user_email);


-- ===== migrations/20260427223000_add_audience_segment_fallback_tables.sql =====
create table if not exists public.audience_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  tag text not null default 'WhatsApp Segment',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.audience_segment_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  audience_id uuid not null references public.audience_segments(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  unique (audience_id, contact_id)
);

alter table public.audience_segments enable row level security;
alter table public.audience_segment_contacts enable row level security;

drop policy if exists "Users can view own audience segments" on public.audience_segments;
drop policy if exists "Users can create own audience segments" on public.audience_segments;
drop policy if exists "Users can update own audience segments" on public.audience_segments;
drop policy if exists "Users can delete own audience segments" on public.audience_segments;

create policy "Users can view own audience segments"
on public.audience_segments
for select
using (auth.uid() = user_id);

create policy "Users can create own audience segments"
on public.audience_segments
for insert
with check (auth.uid() = user_id);

create policy "Users can update own audience segments"
on public.audience_segments
for update
using (auth.uid() = user_id);

create policy "Users can delete own audience segments"
on public.audience_segments
for delete
using (auth.uid() = user_id);

drop policy if exists "Users can view own audience segment contacts" on public.audience_segment_contacts;
drop policy if exists "Users can create own audience segment contacts" on public.audience_segment_contacts;
drop policy if exists "Users can delete own audience segment contacts" on public.audience_segment_contacts;

create policy "Users can view own audience segment contacts"
on public.audience_segment_contacts
for select
using (auth.uid() = user_id);

create policy "Users can create own audience segment contacts"
on public.audience_segment_contacts
for insert
with check (auth.uid() = user_id);

create policy "Users can delete own audience segment contacts"
on public.audience_segment_contacts
for delete
using (auth.uid() = user_id);

drop trigger if exists update_audience_segments_updated_at on public.audience_segments;
create trigger update_audience_segments_updated_at
before update on public.audience_segments
for each row execute function public.update_updated_at_column();

create index if not exists audience_segments_user_id_idx
on public.audience_segments(user_id, created_at desc);

create index if not exists audience_segment_contacts_user_id_idx
on public.audience_segment_contacts(user_id, audience_id);


-- ===== migrations/20260427224500_add_audience_campaign_fallback_table.sql =====
create table if not exists public.audience_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  audience_id uuid references public.audience_segments(id) on delete set null,
  template_id uuid references public."Templates"(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'failed')),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.audience_campaigns enable row level security;

drop policy if exists "Users can view own audience campaigns" on public.audience_campaigns;
drop policy if exists "Users can create own audience campaigns" on public.audience_campaigns;
drop policy if exists "Users can update own audience campaigns" on public.audience_campaigns;
drop policy if exists "Users can delete own audience campaigns" on public.audience_campaigns;

create policy "Users can view own audience campaigns"
on public.audience_campaigns
for select
using (auth.uid() = user_id);

create policy "Users can create own audience campaigns"
on public.audience_campaigns
for insert
with check (auth.uid() = user_id);

create policy "Users can update own audience campaigns"
on public.audience_campaigns
for update
using (auth.uid() = user_id);

create policy "Users can delete own audience campaigns"
on public.audience_campaigns
for delete
using (auth.uid() = user_id);

drop trigger if exists update_audience_campaigns_updated_at on public.audience_campaigns;
create trigger update_audience_campaigns_updated_at
before update on public.audience_campaigns
for each row execute function public.update_updated_at_column();

create index if not exists audience_campaigns_user_id_idx
on public.audience_campaigns(user_id, created_at desc);


-- ===== migrations/20260427231500_add_campaign_runtime_fields.sql =====
alter table public.whatsapp_campaigns
  add column if not exists started_at timestamp with time zone,
  add column if not exists completed_at timestamp with time zone,
  add column if not exists total_contacts integer not null default 0,
  add column if not exists sent_count integer not null default 0,
  add column if not exists failed_count integer not null default 0,
  add column if not exists outcomes jsonb not null default '[]'::jsonb;

alter table public.audience_campaigns
  add column if not exists started_at timestamp with time zone,
  add column if not exists completed_at timestamp with time zone,
  add column if not exists total_contacts integer not null default 0,
  add column if not exists sent_count integer not null default 0,
  add column if not exists failed_count integer not null default 0,
  add column if not exists outcomes jsonb not null default '[]'::jsonb;


-- ===== migrations/20260428003000_relax_audience_fallback_user_fk.sql =====
alter table if exists public.audience_segments
  drop constraint if exists audience_segments_user_id_fkey;

alter table if exists public.audience_segment_contacts
  drop constraint if exists audience_segment_contacts_user_id_fkey;

alter table if exists public.audience_campaigns
  drop constraint if exists audience_campaigns_user_id_fkey;


-- ===== migrations/20260428170500_add_campaign_template_snapshot_fields.sql =====
alter table public.whatsapp_campaigns
  add column if not exists template_name text,
  add column if not exists template_language text,
  add column if not exists template_structure jsonb not null default '{}'::jsonb,
  add column if not exists delivered integer not null default 0,
  add column if not exists failed integer not null default 0,
  add column if not exists sent_date timestamp with time zone;

alter table public.audience_campaigns
  add column if not exists template_name text,
  add column if not exists template_language text,
  add column if not exists template_structure jsonb not null default '{}'::jsonb,
  add column if not exists delivered integer not null default 0,
  add column if not exists failed integer not null default 0,
  add column if not exists sent_date timestamp with time zone;


-- ===== migrations/20260521234500_create_agency_access_grants.sql =====
create table if not exists public.agency_access_grants (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  is_active boolean not null default true,
  granted_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agency_access_grants_email_key unique (email)
);

create index if not exists agency_access_grants_is_active_idx
on public.agency_access_grants(is_active);

create index if not exists agency_access_grants_email_idx
on public.agency_access_grants(email);

alter table public.agency_access_grants enable row level security;

create policy "No direct access"
on public.agency_access_grants
for all
using (false);

create trigger update_agency_access_grants_updated_at
before update on public.agency_access_grants
for each row
execute function public.update_updated_at_column();


-- ===== migrations/20260523120000_add_agency_read_policy.sql =====
create policy "Allow active agencies to check their own status"
on public.agency_access_grants
for select
using (email = auth.jwt()->>'email' and is_active = true);


-- ===== migrations/20260523123000_add_agency_email_to_profiles.sql =====
-- Add agency_email column to public.profiles table
ALTER TABLE public.profiles ADD COLUMN agency_email TEXT;

-- Create index on agency_email for faster filtering
CREATE INDEX IF NOT EXISTS profiles_agency_email_idx ON public.profiles(agency_email);


-- ===== migrations/20260523130000_hierarchical_access.sql =====
-- 1. Ensure profiles can track who directly spawned/owns them
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_by_email TEXT;

-- 2. Create an indexed mapping table to handle path lookups for Agency-to-Agency delegations
CREATE TABLE IF NOT EXISTS public.agency_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_agency_email TEXT NOT NULL,
    child_agency_email TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(parent_agency_email, child_agency_email)
);

CREATE INDEX IF NOT EXISTS idx_agency_rel_parent ON public.agency_relationships(parent_agency_email);
CREATE INDEX IF NOT EXISTS idx_agency_rel_child ON public.agency_relationships(child_agency_email);

-- 3. Create a view to securely join public.profiles and auth.users
CREATE OR REPLACE VIEW public.client_details AS
SELECT 
  p.user_id,
  u.email,
  p.full_name,
  p.company_name,
  p.agency_email,
  p.created_by_email,
  u.raw_user_meta_data
FROM public.profiles p
JOIN auth.users u ON p.user_id = u.id;


-- ===== migrations/20260523140000_add_agency_code.sql =====
-- Create helper function to generate a random 6-character uppercase alphanumeric code
CREATE OR REPLACE FUNCTION public.generate_agency_code() 
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Add agency_code column to agency_access_grants table
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS agency_code TEXT UNIQUE;

-- Populate existing rows with random 6-digit codes
UPDATE public.agency_access_grants 
SET agency_code = public.generate_agency_code() 
WHERE agency_code IS NULL;


-- ===== migrations/20260523150000_client_agency_code.sql =====
-- Create helper function to generate a random 6-character uppercase alphanumeric code (recreated to ensure it exists on remote)
CREATE OR REPLACE FUNCTION public.generate_agency_code() 
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 1. Add agency_code column to public.profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS agency_code TEXT;

-- 2. Create index on agency_code for faster lookups
CREATE INDEX IF NOT EXISTS profiles_agency_code_idx ON public.profiles(agency_code);

-- 3. Set the DEFAULT value for agency_code in public.agency_access_grants table
-- This guarantees any newly created agency gets a 6-digit code automatically in SQL
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS agency_code TEXT UNIQUE;
ALTER TABLE public.agency_access_grants ALTER COLUMN agency_code SET DEFAULT public.generate_agency_code();

-- 4. Populate existing profiles with their matching agency_code from agency_access_grants
UPDATE public.profiles p
SET agency_code = a.agency_code
FROM public.agency_access_grants a
WHERE p.agency_email IS NOT NULL 
  AND LOWER(TRIM(p.agency_email)) = LOWER(TRIM(a.email))
  AND p.agency_code IS NULL;

-- 5. Recreate client_details view to include the new agency_code field
CREATE OR REPLACE VIEW public.client_details AS
SELECT 
  p.user_id,
  u.email,
  p.full_name,
  p.company_name,
  p.agency_email,
  p.created_by_email,
  u.raw_user_meta_data,
  p.agency_code
FROM public.profiles p
JOIN auth.users u ON p.user_id = u.id;


-- ===== migrations/20260523160000_agency_client_pricing.sql =====
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


-- ===== migrations/20260525000000_hierarchical_pricing_and_packages.sql =====
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


-- ===== migrations/20260525010000_custom_agency_packages.sql =====
-- Migration to support custom minute allocations and package pricing for agencies and subagencies

-- 1. Add custom minutes and custom price columns to public.agency_access_grants table
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS starter_custom_minutes INTEGER;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS starter_custom_price NUMERIC;

ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS pro_custom_minutes INTEGER;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS pro_custom_price NUMERIC;

ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS ultra_custom_minutes INTEGER;
ALTER TABLE public.agency_access_grants ADD COLUMN IF NOT EXISTS ultra_custom_price NUMERIC;


-- ===== migrations/20260525020000_rename_checkout_urls_and_add_wholesale.sql =====
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


-- ===== migrations/20260528143500_add_timezone_to_profiles.sql =====
-- Add timezone column to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC';


-- ===== migrations/20260530000000_atomic_minute_balance.sql =====
-- Atomic minute-balance mutations.
--
-- The previous helpers read available_seconds, computed a new value in the edge
-- function, then wrote it back. Two concurrent requests could both read the same
-- starting value and overwrite each other, losing a credit or double-spending a
-- deduction. These functions perform the arithmetic inside a single statement so
-- Postgres row locking guarantees correctness under concurrency.

-- Credit (add) seconds to a user's balance, creating the row if missing.
create or replace function public.increment_minute_balance(
  p_user_id uuid,
  p_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available integer;
begin
  insert into public.user_minute_balances (user_id, available_seconds)
  values (p_user_id, greatest(0, p_seconds))
  on conflict (user_id) do update
    set available_seconds = public.user_minute_balances.available_seconds + p_seconds
  returning available_seconds into v_available;

  return v_available;
end;
$$;

-- Deduct seconds, never going below zero. Returns the seconds actually deducted.
create or replace function public.deduct_minute_balance(
  p_user_id uuid,
  p_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available integer;
  v_deducted integer;
begin
  select available_seconds into v_available
  from public.user_minute_balances
  where user_id = p_user_id
  for update;

  if v_available is null then
    return 0;
  end if;

  v_deducted := least(v_available, greatest(0, p_seconds));

  update public.user_minute_balances
  set available_seconds = available_seconds - v_deducted
  where user_id = p_user_id;

  return v_deducted;
end;
$$;

revoke all on function public.increment_minute_balance(uuid, integer) from public, anon, authenticated;
revoke all on function public.deduct_minute_balance(uuid, integer) from public, anon, authenticated;
grant execute on function public.increment_minute_balance(uuid, integer) to service_role;
grant execute on function public.deduct_minute_balance(uuid, integer) to service_role;

COMMIT;
