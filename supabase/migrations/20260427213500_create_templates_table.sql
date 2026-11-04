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
