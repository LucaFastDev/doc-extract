-- Issue #71 (ARCHITECTURE.md section 7): the spend reservation is meant to be an upper bound on a
-- Claude call, but the fixed part of a request (system prompt and tool definitions) is about 18,000
-- tokens by the eval dry run's estimate, far above the 4000 set here before. 20000 until a real eval
-- run is committed. The site is not deployed, so no row has been tuned by hand: a plain update.

alter table public.app_config alter column base_input_tokens set default 20000;

update public.app_config set base_input_tokens = 20000;
