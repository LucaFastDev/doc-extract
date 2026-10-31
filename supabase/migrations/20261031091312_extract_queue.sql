-- Milestone 5 (ARCHITECTURE.md sections 4.1, 4.2, 6.3, 6.4 and 7): the extract queue and the cron
-- job that drives process-queue, the tables an extraction writes, the spend cap and the daily
-- ceiling, app_config, and the functions that reserve, settle and release. Lead rulings on #24:
-- pgmq is reached only through service_role wrappers in public (1); a release subtracts from the
-- month the pages were counted against (2); the cron job reads app_config.extract_concurrency (3);
-- reserve_spend decides with app_config's caps on every call (8).

-- Tables ----------------------------------------------------------------------------------------

-- Single-row configuration. The operator changes these values with SQL, without a release
-- (PRD US-2.1 AC-4, US-12.1 AC-5). Prices are Sonnet 5.5's on Anthropic's pricing page
-- (https://platform.claude.com/docs/en/about-claude/pricing, read by the Lead on 2026-10-31).
create table public.app_config (
  id boolean primary key default true check (id),
  spend_cap_usd numeric(10, 2) not null default 10.00 check (spend_cap_usd >= 0),
  daily_cap_usd numeric(10, 2) not null default 2.00 check (daily_cap_usd >= 0),
  -- null turns the account cap off (OQ-2).
  account_page_cap int default 10 check (account_page_cap >= 0),
  model text not null default 'claude-sonnet-5-5',
  input_usd_per_mtok numeric(10, 3) not null default 2,
  output_usd_per_mtok numeric(10, 3) not null default 10,
  -- The upper bound of a call's cost (section 7): the system prompt and tool definitions, the most
  -- a page can add, and the call's max_tokens. The eval (milestone 13) calibrates them.
  base_input_tokens int not null default 4000 check (base_input_tokens > 0),
  max_input_tokens_per_page int not null default 5000 check (max_input_tokens_per_page > 0),
  max_output_tokens int not null default 8192 check (max_output_tokens > 0),
  confidence_threshold numeric(4, 3) not null default 0.800,
  amount_tolerance numeric(10, 2) not null default 0.01,
  -- How many process-queue requests the cron job sends each run (Lead ruling 3); 0 sends none.
  extract_concurrency int not null default 1 check (extract_concurrency >= 0)
);

insert into public.app_config (id) values (true);

-- The month reserve_pages counted a document's pages against, so release_pages gives them back
-- to that month and never to the current one (Lead ruling 2). Rows reserved before this column
-- existed counted against the month they were created in.
alter table public.documents add column pages_period_start date;
update public.documents set pages_period_start = date_trunc('month', created_at at time zone 'utc')::date
where pages_reserved;

-- A document's history: approvals, reopens, type changes and retries (OQ-12, OQ-44).
create table public.document_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete cascade,
  workspace_id uuid,
  kind text check (kind in ('approved', 'reopened', 'type_changed', 'retried')),
  actor uuid references public.profiles (id) on delete set null,
  created_at timestamptz default now()
);

create index document_events_document_id_idx on public.document_events (document_id);

-- One row per field or line-item cell.
create table public.extraction_fields (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete cascade,
  workspace_id uuid,
  path text,
  kind text check (kind in ('text', 'date', 'amount', 'number', 'percent')),
  extracted_value text,
  confidence numeric(4, 3),
  corrected_value text,
  corrected_by uuid references public.profiles (id) on delete set null,
  corrected_at timestamptz,
  flags text[] default '{}',
  unique (document_id, path)
);

create table public.check_results (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete cascade,
  workspace_id uuid,
  check_id text,
  status text check (status in ('pass', 'fail', 'skipped')),
  field_paths text[],
  message text,
  evaluated_at timestamptz,
  unique (document_id, check_id)
);

-- One row per extraction attempt, for cost and debugging. Service role only.
create table public.extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete cascade,
  workspace_id uuid,
  model text,
  prompt_version text,
  tool_name text,
  outcome text check (outcome in ('ok', 'unsupported', 'retryable_error', 'fatal_error', 'invalid_output')),
  error text,
  raw_output jsonb,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(10, 6),
  created_at timestamptz default now()
);

create index extractions_document_id_idx on public.extractions (document_id);

-- AI spend per UTC month and per UTC day (OQ-22, OQ-33). cap_usd records the cap in force when the
-- row was created; reserve_spend decides with app_config's caps (Lead ruling 8).
create table public.ai_spend_periods (
  period_start date primary key,
  cap_usd numeric(10, 2) not null,
  spent_usd numeric(10, 6) not null default 0,
  reserved_usd numeric(10, 6) not null default 0
);

create table public.ai_spend_days (
  day date primary key,
  cap_usd numeric(10, 2) not null,
  spent_usd numeric(10, 6) not null default 0,
  reserved_usd numeric(10, 6) not null default 0
);

create table public.ai_spend_reservations (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete set null,
  period_start date,
  day date,
  estimate_usd numeric(10, 6),
  created_at timestamptz default now(),
  settled_at timestamptz
);

alter table public.app_config enable row level security;
alter table public.document_events enable row level security;
alter table public.extraction_fields enable row level security;
alter table public.check_results enable row level security;
alter table public.extractions enable row level security;
alter table public.ai_spend_periods enable row level security;
alter table public.ai_spend_days enable row level security;
alter table public.ai_spend_reservations enable row level security;

revoke all on table public.app_config from anon, authenticated;
revoke all on table public.document_events from anon, authenticated;
revoke all on table public.extraction_fields from anon, authenticated;
revoke all on table public.check_results from anon, authenticated;
revoke all on table public.extractions from anon, authenticated;
revoke all on table public.ai_spend_periods from anon, authenticated;
revoke all on table public.ai_spend_days from anon, authenticated;
revoke all on table public.ai_spend_reservations from anon, authenticated;

-- Policies and grants ---------------------------------------------------------------------------

-- Members read their workspace's history, fields and check results. Rows are written only by
-- process-queue with the service role and by the RPCs below; corrections to extraction_fields
-- (the corrected_value grant) come with the review screen in milestone 7 (Lead ruling 6).
create policy document_events_select on public.document_events
  for select to authenticated
  using (public.is_member(workspace_id));

create policy extraction_fields_select on public.extraction_fields
  for select to authenticated
  using (public.is_member(workspace_id));

create policy check_results_select on public.check_results
  for select to authenticated
  using (public.is_member(workspace_id));

grant select on table public.document_events to authenticated;
grant select on table public.extraction_fields to authenticated;
grant select on table public.check_results to authenticated;

-- extractions, the spend tables and app_config: no policies and no client grants. Signed-in users
-- learn the budget through get_budget_status() (milestone 10).

-- The extract queue (Lead ruling 1) -------------------------------------------------------------

select pgmq.create('extract');

-- The API exposes only public and graphql_public, so pgmq_public is never exposed. These four
-- wrappers are the only way the service role reaches the queue: security definer, because the
-- service role has no grants on pgmq, and each acts on the extract queue only.
create function public.extract_send(document_id uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select pgmq.send('extract', jsonb_build_object('document_id', extract_send.document_id));
$$;

create function public.extract_read(vt integer, qty integer)
returns table (msg_id bigint, read_ct integer, enqueued_at timestamptz, message jsonb)
language sql
security definer
set search_path = ''
as $$
  select r.msg_id, r.read_ct, r.enqueued_at, r.message from pgmq.read('extract', extract_read.vt, extract_read.qty) r;
$$;

create function public.extract_set_vt(msg_id bigint, vt integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pgmq.set_vt('extract', extract_set_vt.msg_id, extract_set_vt.vt);
end;
$$;

create function public.extract_archive(msg_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select pgmq.archive('extract', extract_archive.msg_id);
$$;

revoke execute on function public.extract_send(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.extract_read(integer, integer) from public, anon, authenticated, service_role;
revoke execute on function public.extract_set_vt(bigint, integer) from public, anon, authenticated, service_role;
revoke execute on function public.extract_archive(bigint) from public, anon, authenticated, service_role;
grant execute on function public.extract_send(uuid) to service_role;
grant execute on function public.extract_read(integer, integer) to service_role;
grant execute on function public.extract_set_vt(bigint, integer) to service_role;
grant execute on function public.extract_archive(bigint) to service_role;

-- account_page_cap ------------------------------------------------------------------------------

-- Same signature and grants as milestone 4; the body now reads app_config (Lead ruling on #20).
create or replace function public.account_page_cap()
returns int
language sql
stable
security invoker
set search_path = ''
as $$
  select c.account_page_cap from public.app_config c where c.id;
$$;

revoke execute on function public.account_page_cap() from public, anon, authenticated, service_role;
grant execute on function public.account_page_cap() to service_role;

-- reserve_pages ---------------------------------------------------------------------------------

-- As milestone 4, and now it records the month it counted against (Lead ruling 2), and a null
-- account cap counts no account limit.
create or replace function public.reserve_pages(document_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.documents;
  period date := date_trunc('month', now() at time zone 'utc')::date;
  ws_limit int;
  ws_used int;
  account_used int;
  cap int := public.account_page_cap();
begin
  select * into doc from public.documents d where d.id = reserve_pages.document_id for update;
  if not found then
    raise exception 'no such document' using errcode = 'P0002';
  end if;
  if doc.pages_reserved then
    return true;
  end if;
  if doc.page_count is null or doc.page_count < 1 then
    raise exception 'the document has no page count' using errcode = '22023';
  end if;
  if doc.uploaded_by is null then
    raise exception 'the document has no uploader' using errcode = '22023';
  end if;

  select l.pages_per_period into ws_limit
  from public.workspaces w join public.plan_limits l on l.plan = w.plan
  where w.id = doc.workspace_id;

  insert into public.page_usage (workspace_id, period_start) values (doc.workspace_id, period)
  on conflict do nothing;
  insert into public.account_page_usage (user_id) values (doc.uploaded_by)
  on conflict do nothing;

  select u.pages_used into ws_used from public.page_usage u
  where u.workspace_id = doc.workspace_id and u.period_start = period for update;
  select a.pages_used into account_used from public.account_page_usage a
  where a.user_id = doc.uploaded_by for update;

  if ws_used + doc.page_count > ws_limit or (cap is not null and account_used + doc.page_count > cap) then
    return false;
  end if;

  update public.page_usage u set pages_used = u.pages_used + doc.page_count
  where u.workspace_id = doc.workspace_id and u.period_start = period;
  update public.account_page_usage a set pages_used = a.pages_used + doc.page_count
  where a.user_id = doc.uploaded_by;
  update public.documents d set pages_reserved = true, pages_period_start = period where d.id = doc.id;
  return true;
end;
$$;

revoke execute on function public.reserve_pages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_pages(uuid) to service_role;

-- release_pages ---------------------------------------------------------------------------------

-- Security invoker, like reserve_pages: called by process-queue's record_extraction and by
-- submit-document with the service role. Gives a document's held pages back when it fails, is not
-- supported, or cannot be queued (OQ-1, OQ-10): to the workspace's row for the month they were
-- counted against, and to the uploader's lifetime row. A document holding no pages gives nothing.
create function public.release_pages(document_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.documents;
begin
  select * into doc from public.documents d where d.id = release_pages.document_id for update;
  if not found then
    raise exception 'no such document' using errcode = 'P0002';
  end if;
  if not coalesce(doc.pages_reserved, false) then
    return;
  end if;

  if doc.pages_period_start is not null then
    update public.page_usage u set pages_used = greatest(0, u.pages_used - doc.page_count)
    where u.workspace_id = doc.workspace_id and u.period_start = doc.pages_period_start;
  end if;
  if doc.uploaded_by is not null then
    update public.account_page_usage a set pages_used = greatest(0, a.pages_used - doc.page_count)
    where a.user_id = doc.uploaded_by;
  end if;
  update public.documents d set pages_reserved = false, pages_period_start = null where d.id = doc.id;
end;
$$;

revoke execute on function public.release_pages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_pages(uuid) to service_role;

-- reserve_spend ---------------------------------------------------------------------------------

-- Security invoker: only process-queue calls it, with the service role. Locks this UTC month's
-- row, then today's (creating either with the cap from app_config), and refuses when the estimate
-- would take either past app_config's cap, which it reads on every call (Lead ruling 8). The
-- monthly cap is checked first, because it is the longer wait. Otherwise it holds the estimate on
-- both rows and records the reservation (section 7).
create function public.reserve_spend(document_id uuid, estimate numeric)
returns table (reservation uuid, refused_by text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cfg public.app_config;
  this_month date := date_trunc('month', now() at time zone 'utc')::date;
  today date := (now() at time zone 'utc')::date;
  month_row public.ai_spend_periods;
  day_row public.ai_spend_days;
  held uuid;
begin
  if reserve_spend.estimate is null or reserve_spend.estimate < 0 then
    raise exception 'the estimate must be a cost of 0 or more' using errcode = '22023';
  end if;
  select * into cfg from public.app_config c where c.id;

  insert into public.ai_spend_periods (period_start, cap_usd) values (this_month, cfg.spend_cap_usd)
  on conflict do nothing;
  insert into public.ai_spend_days (day, cap_usd) values (today, cfg.daily_cap_usd)
  on conflict do nothing;
  select * into month_row from public.ai_spend_periods p where p.period_start = this_month for update;
  select * into day_row from public.ai_spend_days d where d.day = today for update;

  if month_row.spent_usd + month_row.reserved_usd + reserve_spend.estimate > cfg.spend_cap_usd then
    return query select null::uuid, 'monthly'::text;
    return;
  end if;
  if day_row.spent_usd + day_row.reserved_usd + reserve_spend.estimate > cfg.daily_cap_usd then
    return query select null::uuid, 'daily'::text;
    return;
  end if;

  update public.ai_spend_periods p set reserved_usd = p.reserved_usd + reserve_spend.estimate
  where p.period_start = this_month;
  update public.ai_spend_days d set reserved_usd = d.reserved_usd + reserve_spend.estimate
  where d.day = today;
  insert into public.ai_spend_reservations (document_id, period_start, day, estimate_usd)
  values (reserve_spend.document_id, this_month, today, reserve_spend.estimate)
  returning id into held;
  return query select held, null::text;
end;
$$;

revoke execute on function public.reserve_spend(uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.reserve_spend(uuid, numeric) to service_role;

-- settle_spend ----------------------------------------------------------------------------------

-- Security invoker, service role only. Moves a reservation's estimate out of reserved_usd and adds
-- the actual cost to spent_usd, on the month and day it was reserved in, once. A cost over the
-- estimate is logged as a warning, so a wrong estimate setting shows in the database logs.
create function public.settle_spend(reservation uuid, actual_cost numeric)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.ai_spend_reservations;
begin
  if settle_spend.actual_cost is null or settle_spend.actual_cost < 0 then
    raise exception 'the actual cost must be 0 or more' using errcode = '22023';
  end if;
  select * into r from public.ai_spend_reservations x where x.id = settle_spend.reservation for update;
  if not found then
    raise exception 'no such reservation' using errcode = 'P0002';
  end if;
  if r.settled_at is not null then
    return;
  end if;

  update public.ai_spend_periods p
  set reserved_usd = greatest(0, p.reserved_usd - r.estimate_usd), spent_usd = p.spent_usd + settle_spend.actual_cost
  where p.period_start = r.period_start;
  update public.ai_spend_days d
  set reserved_usd = greatest(0, d.reserved_usd - r.estimate_usd), spent_usd = d.spent_usd + settle_spend.actual_cost
  where d.day = r.day;
  update public.ai_spend_reservations x set settled_at = now() where x.id = r.id;

  if settle_spend.actual_cost > r.estimate_usd then
    raise warning 'settle_spend: reservation % cost % USD, over its estimate of % USD', r.id, settle_spend.actual_cost, r.estimate_usd;
  end if;
end;
$$;

revoke execute on function public.settle_spend(uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.settle_spend(uuid, numeric) to service_role;

-- record_extraction -----------------------------------------------------------------------------

-- Security invoker, service role only. Stores one extraction attempt in one transaction (section
-- 6.3 step 8): settles the spend reservation, locks the document, writes the extractions row, and
-- moves the document to its next status. result is the attempt as process-queue built it:
--   outcome, status (needs_review, unsupported, queued or failed), status_reason, model,
--   prompt_version, tool_name, error, raw_output, input_tokens, output_tokens, cost_usd, doc_type,
--   fields [{path, kind, extracted_value, confidence, flags}],
--   checks [{check_id, status, field_paths, message}].
-- needs_review stores the fields and checks, replacing any earlier ones; unsupported and failed
-- release the document's pages (OQ-1, OQ-10); queued leaves them held for the next attempt.
-- Returns 'recorded'; 'deleted' when a member deleted the document during the call, so only the
-- spend was settled; or 'stale' when the document is no longer processing, so only the attempt
-- was logged.
create function public.record_extraction(document_id uuid, reservation uuid, result jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.documents;
  new_status text := record_extraction.result ->> 'status';
  attempt_outcome text := record_extraction.result ->> 'outcome';
begin
  if new_status is null or new_status not in ('needs_review', 'unsupported', 'queued', 'failed') then
    raise exception 'an extraction ends in needs_review, unsupported, queued or failed' using errcode = '22023';
  end if;
  if attempt_outcome is null
    or attempt_outcome not in ('ok', 'unsupported', 'retryable_error', 'fatal_error', 'invalid_output')
    or (new_status = 'needs_review') <> (attempt_outcome = 'ok') then
    raise exception 'the outcome does not match the status' using errcode = '22023';
  end if;

  if record_extraction.reservation is not null then
    perform public.settle_spend(record_extraction.reservation, coalesce((record_extraction.result ->> 'cost_usd')::numeric, 0));
  end if;

  select * into doc from public.documents d where d.id = record_extraction.document_id for update;
  if not found then
    return 'deleted';
  end if;

  insert into public.extractions (
    document_id, workspace_id, model, prompt_version, tool_name, outcome, error, raw_output, input_tokens,
    output_tokens, cost_usd
  ) values (
    doc.id, doc.workspace_id, result ->> 'model', result ->> 'prompt_version', result ->> 'tool_name', attempt_outcome,
    result ->> 'error', result -> 'raw_output', (result ->> 'input_tokens')::int, (result ->> 'output_tokens')::int,
    coalesce((result ->> 'cost_usd')::numeric, 0)
  );

  if doc.status <> 'processing' then
    return 'stale';
  end if;

  if new_status = 'needs_review' then
    delete from public.extraction_fields f where f.document_id = doc.id;
    delete from public.check_results c where c.document_id = doc.id;
    insert into public.extraction_fields (document_id, workspace_id, path, kind, extracted_value, confidence, flags)
    select doc.id, doc.workspace_id, e ->> 'path', e ->> 'kind', e ->> 'extracted_value', (e ->> 'confidence')::numeric,
           array(select jsonb_array_elements_text(coalesce(e -> 'flags', '[]'::jsonb)))
    from jsonb_array_elements(coalesce(result -> 'fields', '[]'::jsonb)) e;
    insert into public.check_results (document_id, workspace_id, check_id, status, field_paths, message, evaluated_at)
    select doc.id, doc.workspace_id, e ->> 'check_id', e ->> 'status',
           array(select jsonb_array_elements_text(coalesce(e -> 'field_paths', '[]'::jsonb))), e ->> 'message', now()
    from jsonb_array_elements(coalesce(result -> 'checks', '[]'::jsonb)) e;
    update public.documents d
    set status = 'needs_review', status_reason = null, doc_type = coalesce(result ->> 'doc_type', doc.doc_type),
        doc_type_source = case when doc.doc_type_source = 'user' then 'user' else 'detected' end,
        processed_at = now(), processing_started_at = null
    where d.id = doc.id;
  elsif new_status in ('unsupported', 'failed') then
    update public.documents d
    set status = new_status, status_reason = result ->> 'status_reason', processed_at = now(), processing_started_at = null
    where d.id = doc.id;
    perform public.release_pages(doc.id);
  else
    update public.documents d
    set status = 'queued', status_reason = result ->> 'status_reason', processing_started_at = null
    where d.id = doc.id;
  end if;
  return 'recorded';
end;
$$;

revoke execute on function public.record_extraction(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_extraction(uuid, uuid, jsonb) to service_role;

-- retry_document --------------------------------------------------------------------------------

-- Security definer: it updates documents and writes document_events, reserves pages and sends to
-- the queue, none of which clients may do (section 6.4, OQ-10). Any member may retry a failed
-- document whose file is not deleted; its pages are reserved again, refused like an upload when
-- they no longer fit (PRD US-1.2 AC-5, US-2.1 AC-6 and AC-7).
create function public.retry_document(document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  doc public.documents;
  ws_left int;
  account_left int;
  pages_left int;
begin
  select * into doc from public.documents d where d.id = retry_document.document_id for update;
  if caller is null or doc.id is null or not public.is_member(doc.workspace_id) then
    raise exception 'not a member of this document''s workspace' using errcode = '42501';
  end if;
  if doc.status is distinct from 'failed' then
    raise exception 'Only a failed document can be retried.' using errcode = '22023';
  end if;
  if doc.file_deleted_at is not null then
    raise exception '% cannot be retried: its file has been deleted.', doc.file_name using errcode = '22023';
  end if;

  if not public.reserve_pages(doc.id) then
    select l.pages_per_period - coalesce(u.pages_used, 0) into ws_left
    from public.workspaces w
    join public.plan_limits l on l.plan = w.plan
    left join public.page_usage u
      on u.workspace_id = w.id and u.period_start = date_trunc('month', now() at time zone 'utc')::date
    where w.id = doc.workspace_id;
    select public.account_page_cap() - coalesce(a.pages_used, 0) into account_left
    from (select 1) one left join public.account_page_usage a on a.user_id = doc.uploaded_by;
    pages_left := greatest(0, least(ws_left, coalesce(account_left, ws_left)));
    raise exception '% has % %, but only % % of the page allowance (the workspace’s pages this month and the uploader’s lifetime cap).',
      doc.file_name, doc.page_count, case when doc.page_count = 1 then 'page' else 'pages' end,
      pages_left, case when pages_left = 1 then 'page remains' else 'pages remain' end
      using errcode = '22023';
  end if;

  update public.documents d
  set status = 'queued', status_reason = null, attempts = 0, processing_started_at = null, processed_at = null
  where d.id = doc.id;
  insert into public.document_events (document_id, workspace_id, kind, actor)
  values (doc.id, doc.workspace_id, 'retried', caller);
  perform public.extract_send(doc.id);
end;
$$;

revoke execute on function public.retry_document(uuid) from public, anon, authenticated, service_role;
grant execute on function public.retry_document(uuid) to authenticated;

-- The cron job ----------------------------------------------------------------------------------

-- Every 10 seconds, pg_cron posts to process-queue as many times as app_config.extract_concurrency
-- (Lead ruling 3), with the functions' base URL and CRON_SECRET read from Vault, so neither is in
-- a migration (section 12). Each request handles one message. The long timeout keeps pg_net from
-- giving up on a request while process-queue waits on Claude.
select cron.schedule(
  'process-queue',
  '10 seconds',
  $job$
  select net.http_post(
    url := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'functions_base_url') || '/process-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  )
  from generate_series(1, (select c.extract_concurrency from public.app_config c where c.id))
  $job$
);
