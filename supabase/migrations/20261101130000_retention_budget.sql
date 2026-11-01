-- Milestone 10 (ARCHITECTURE.md sections 4.1, 7 and 8, PRD F12 and F14, issue #48): the AI
-- budget the document list shows, the sweep of spend reservations a killed run left, the daily
-- purge-files job, and the cleanup of pg_cron's run log (Lead ruling 2 on #48).

-- release_stale_spend_reservations -----------------------------------------------------------

-- Security invoker, service role only: purge-files calls it once a run (section 8 step 4). A
-- reservation that was never settled 15 minutes after it was made belongs to a process-queue run
-- that was killed (section 6.4): a run is cut off by Claude's 120-second timeout and the Edge
-- Function's time limit long before that. Its estimate leaves reserved_usd on the month row and
-- the day row it was added to, never the current ones, and nothing is added to spent_usd. It is
-- marked settled, so a release happens once and a late settle_spend changes nothing. Locks the
-- reservations first and then the spend rows, in the order settle_spend takes them. Returns how
-- many it released.
create function public.release_stale_spend_reservations()
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.ai_spend_reservations;
  released int := 0;
begin
  for r in
    select * from public.ai_spend_reservations x
    where x.settled_at is null and x.created_at < now() - interval '15 minutes'
    order by x.created_at
    for update
  loop
    update public.ai_spend_periods p set reserved_usd = greatest(0, p.reserved_usd - r.estimate_usd)
    where p.period_start = r.period_start;
    update public.ai_spend_days d set reserved_usd = greatest(0, d.reserved_usd - r.estimate_usd)
    where d.day = r.day;
    update public.ai_spend_reservations x set settled_at = now() where x.id = r.id;
    released := released + 1;
  end loop;
  return released;
end;
$$;

revoke execute on function public.release_stale_spend_reservations() from public, anon, authenticated, service_role;
grant execute on function public.release_stale_spend_reservations() to service_role;

-- get_budget_status -----------------------------------------------------------------------------

-- Security definer: it reads ai_spend_periods, ai_spend_days and app_config, which have no client
-- grants; for signed-in users only (OQ-22). Returns this UTC month's spend and the monthly cap
-- from app_config now (not the cap the row recorded, Lead ruling 8 on #24), and whether the daily
-- ceiling and the monthly cap are reached: the budget left, after what is spent and what is
-- reserved, is below the estimate for a one-page document, which is when reserve_spend would
-- refuse one (section 7). resumes_at is when waiting documents resume (OQ-23): the next UTC
-- midnight for the daily ceiling, the first day of the next UTC month for the monthly cap, the
-- later of the two when both are reached, null when neither is.
create function public.get_budget_status()
returns table (spent_usd numeric, cap_usd numeric, daily_reached boolean, monthly_reached boolean, resumes_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cfg public.app_config;
  utc_now timestamp := now() at time zone 'utc';
  month_spent numeric;
  month_reserved numeric;
  day_spent numeric;
  day_reserved numeric;
  one_page numeric;
  daily boolean;
  monthly boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'sign in to see the AI budget' using errcode = '42501';
  end if;
  select * into cfg from public.app_config c where c.id;
  -- As process-queue's estimate for one page (section 7), rounded up to the micro-dollar as it
  -- sends it: tokens times USD per million tokens is micro-dollars.
  one_page := ceil(
    (cfg.base_input_tokens + cfg.max_input_tokens_per_page) * cfg.input_usd_per_mtok
      + cfg.max_output_tokens * cfg.output_usd_per_mtok
  ) / 1e6;

  select p.spent_usd, p.reserved_usd into month_spent, month_reserved
  from public.ai_spend_periods p where p.period_start = date_trunc('month', utc_now)::date;
  select d.spent_usd, d.reserved_usd into day_spent, day_reserved
  from public.ai_spend_days d where d.day = utc_now::date;
  month_spent := coalesce(month_spent, 0);
  month_reserved := coalesce(month_reserved, 0);
  day_spent := coalesce(day_spent, 0);
  day_reserved := coalesce(day_reserved, 0);

  monthly := cfg.spend_cap_usd - month_spent - month_reserved < one_page;
  daily := cfg.daily_cap_usd - day_spent - day_reserved < one_page;

  return query select
    month_spent,
    cfg.spend_cap_usd,
    daily,
    monthly,
    case
      when monthly then (date_trunc('month', utc_now) + interval '1 month') at time zone 'utc'
      when daily then (date_trunc('day', utc_now) + interval '1 day') at time zone 'utc'
    end;
end;
$$;

revoke execute on function public.get_budget_status() from public, anon, authenticated, service_role;
grant execute on function public.get_budget_status() to authenticated;

-- The cron jobs ---------------------------------------------------------------------------------

-- Daily at 03:00 UTC, pg_cron posts to purge-files as the process-queue job posts to its
-- function: the functions' base URL and CRON_SECRET read from Vault, so neither is in a migration
-- (section 12). Running daily keeps every file under 8 days old (US-14.1 AC-1, OQ-39). The long
-- timeout keeps pg_net from giving up on a run that removes many files.
select cron.schedule(
  'purge-files',
  '0 3 * * *',
  $job$
  select net.http_post(
    url := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'functions_base_url') || '/purge-files',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  )
  $job$
);

-- pg_cron logs every run of every job in cron.job_run_details, the process-queue job alone about
-- 8,600 rows a day. Daily, after the purge, rows older than 7 days are deleted, in plain SQL with
-- no function call (Lead ruling 2 on #48).
select cron.schedule(
  'cron-history-cleanup',
  '30 3 * * *',
  $job$ delete from cron.job_run_details where start_time < now() - interval '7 days' $job$
);
