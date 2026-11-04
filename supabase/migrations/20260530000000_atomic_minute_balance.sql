-- Atomic minute-balance mutations.
--
-- The previous helpers read available_seconds, computed a new value in the edge
-- function, then wrote it back. Two concurrent requests could both read the same
-- starting value and overwrite each other, losing a credit or double-spending a
-- deduction. These functions perform the arithmetic inside a single statement so
-- Postgres row locking guarantees correctness under concurrency.

-- Credit (add) seconds to a user's balance, creating the row if missing.
create or replace function public.increment_minute_balance(
  p_user_id uuid,
  p_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available integer;
begin
  insert into public.user_minute_balances (user_id, available_seconds)
  values (p_user_id, greatest(0, p_seconds))
  on conflict (user_id) do update
    set available_seconds = public.user_minute_balances.available_seconds + p_seconds
  returning available_seconds into v_available;

  return v_available;
end;
$$;

-- Deduct seconds, never going below zero. Returns the seconds actually deducted.
create or replace function public.deduct_minute_balance(
  p_user_id uuid,
  p_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available integer;
  v_deducted integer;
begin
  select available_seconds into v_available
  from public.user_minute_balances
  where user_id = p_user_id
  for update;

  if v_available is null then
    return 0;
  end if;

  v_deducted := least(v_available, greatest(0, p_seconds));

  update public.user_minute_balances
  set available_seconds = available_seconds - v_deducted
  where user_id = p_user_id;

  return v_deducted;
end;
$$;

revoke all on function public.increment_minute_balance(uuid, integer) from public, anon, authenticated;
revoke all on function public.deduct_minute_balance(uuid, integer) from public, anon, authenticated;
grant execute on function public.increment_minute_balance(uuid, integer) to service_role;
grant execute on function public.deduct_minute_balance(uuid, integer) to service_role;
