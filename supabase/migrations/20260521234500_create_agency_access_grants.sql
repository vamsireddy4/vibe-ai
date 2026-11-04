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
