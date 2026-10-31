-- The extensions the extraction pipeline runs on (ARCHITECTURE.md section 1): pgmq holds the
-- extract queue, pg_cron schedules process-queue and purge-files, and pg_net lets those jobs call
-- the Edge Functions. Queues, jobs and tables come in later milestones.

create extension if not exists pgmq;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
