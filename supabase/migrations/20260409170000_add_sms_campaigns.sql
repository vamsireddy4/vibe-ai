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
