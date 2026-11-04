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
