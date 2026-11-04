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
