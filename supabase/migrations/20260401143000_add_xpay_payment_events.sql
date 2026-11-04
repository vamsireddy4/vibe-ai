alter table public.minute_transactions
  drop constraint if exists minute_transactions_kind_check;

alter table public.minute_transactions
  add constraint minute_transactions_kind_check
  check (kind in ('signup_credit', 'admin_credit', 'demo_deduction', 'live_deduction', 'direct_purchase'));

create table if not exists public.xpay_payment_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique,
  event_type text not null,
  intent_id text,
  subscription_id text,
  customer_email text,
  amount numeric(10, 2),
  currency text,
  plan_name text,
  user_id uuid references auth.users(id) on delete set null,
  minutes_credited integer not null default 0,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);
