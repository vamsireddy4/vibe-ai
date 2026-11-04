create table if not exists public.training_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  role text not null,
  company_name text null,
  industry text not null,
  description text not null,
  tags jsonb not null default '[]'::jsonb,
  common_objections text null,
  call_type text not null default 'Cold Call',
  turn_mode text not null default 'Agent starts',
  difficulty text not null default 'Medium' check (difficulty in ('Easy', 'Medium', 'Hard')),
  system_prompt text not null,
  voice_name text null,
  voice_language text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_agents_user_id_idx
  on public.training_agents(user_id);

create index if not exists training_agents_created_at_idx
  on public.training_agents(created_at desc);

alter table public.training_agents enable row level security;

create policy "Users can view own training agents"
on public.training_agents
for select
using (auth.uid() = user_id);

create policy "Users can create own training agents"
on public.training_agents
for insert
with check (auth.uid() = user_id);

create policy "Users can update own training agents"
on public.training_agents
for update
using (auth.uid() = user_id);

create policy "Users can delete own training agents"
on public.training_agents
for delete
using (auth.uid() = user_id);

create trigger update_training_agents_updated_at
before update on public.training_agents
for each row execute function public.update_updated_at_column();

alter publication supabase_realtime add table public.training_agents;
