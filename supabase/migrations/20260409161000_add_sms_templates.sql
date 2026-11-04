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
