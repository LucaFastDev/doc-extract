-- Local and CI data, applied by `npx supabase db reset` after the migrations. Each milestone adds
-- the rows its tests need, including the demo rows (milestone 11).

-- The Vault entries the process-queue cron job reads (milestone 5, ARCHITECTURE.md section 12), so
-- the job runs locally and in CI. The database reaches the Edge Functions through the API gateway
-- on the stack's own Docker network, where it is called kong. The secret is a local value, the
-- same one e2e/mock-claude/functions-env.ts writes to supabase/functions/.env; production's live
-- only in its own Vault and function secrets (docs/go-live.md).
select vault.create_secret('http://kong:8000/functions/v1', 'functions_base_url', 'Edge Functions base URL for pg_cron, local stack');
select vault.create_secret('local-cron-secret-not-for-production', 'cron_secret', 'CRON_SECRET for pg_cron, local stack');

-- app_config keeps the values its migration inserts, so the tests cover the account cap of 10 and
-- the daily ceiling of $2.
