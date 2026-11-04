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
