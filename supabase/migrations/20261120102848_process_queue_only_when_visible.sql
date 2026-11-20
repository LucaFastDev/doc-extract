-- The process-queue cron job posted to its function every 10 seconds whether or not anything was
-- queued: about 8,600 requests a day, each logged by the API gateway, the function's invocation
-- log and its boot and shutdown lines. Idle, that was about 21 MB of log ingestion a day, against
-- the 1 GB a month the Free plan includes for the whole organisation.
--
-- cron.schedule with an existing job name replaces that job, so this reschedules the job of
-- 20261031091312_extract_queue.sql and leaves that migration as it is. Nothing else changes: no
-- table, column, constraint or function, and neither of the other two jobs.

-- Every 10 seconds, pg_cron posts to process-queue as many times as app_config.extract_concurrency
-- (Lead ruling 3), with the functions' base URL and CRON_SECRET read from Vault, so neither is in
-- a migration (section 12). Each request handles one message. The long timeout keeps pg_net from
-- giving up on a request while process-queue waits on Claude.
--
-- It posts only when the extract queue holds a message that is visible now (vt <= now()), to keep
-- log ingestion down: a run with nothing to read would only answer 'empty'. A message is
-- invisible while a run holds it (300 s) or while it is delayed (waiting for budget, or behind
-- another run); it does not trigger a post until its vt passes, and then the next run posts for
-- it. So the check is on vt, not on pgmq.metrics' queue_length, which counts invisible messages
-- too. pg_cron still runs, and logs, the job itself every 10 seconds.
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
  where exists (select 1 from pgmq.q_extract q where q.vt <= now())
  $job$
);
