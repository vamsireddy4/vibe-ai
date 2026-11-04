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
