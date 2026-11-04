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
