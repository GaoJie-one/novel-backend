create table if not exists public.generation_usage (
  user_id uuid not null,
  usage_date date not null default current_date,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create or replace function public.consume_generation_quota(
  p_user_id uuid,
  p_daily_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.generation_usage (user_id, usage_date, count)
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update
    set count = public.generation_usage.count + 1,
        updated_at = now()
    where public.generation_usage.count < p_daily_limit
  returning count into v_count;

  return v_count is not null;
end;
$$;
