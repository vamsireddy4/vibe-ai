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
