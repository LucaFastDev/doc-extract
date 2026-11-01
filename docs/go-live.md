# Go-live checklist: doc-extract

What must be true in **production** for this project to work, and how each item is checked there.
Local tests and CI cannot see any of it: it is configuration and outside services, not code
(docs/05-deploys.md in ai-hq, "The go-live checklist"; D97).

**Who runs it.** The operator, or a laptop session they supervise. An agent never runs a
production step on its own. Run it in full before the first handoff or release, and again for
every item a change adds or touches.

**How it grows.** Every spec that adds or changes an external service, a secret or environment
variable, a Supabase project setting, an auth provider, a domain, a scheduled job, a storage
bucket or an edge function secret adds its items here, in the same PR. An item says what to
check, where, and what "pass" looks like. Never write a secret's value here: name it and where it
is stored.

The design behind these items is in [ARCHITECTURE.md](ARCHITECTURE.md); section numbers below
refer to it. Where an item follows from one of the operator's answers in [PRD.md](PRD.md), it names
the question (OQ-n).

The site is served on its Vercel address, `https://<project>.vercel.app`; there is no custom
domain (OQ-27). `<site>` below means that address.

## Last full run

| Date | Who | Release or commit | Result |
|---|---|---|---|
| | | | |

## Environment and secrets

- [ ] **Vercel project**: Vercel → the doc-extract project → Settings → Environment Variables →
      Production holds `NEXT_PUBLIC_SUPABASE_URL` (the production project's URL, not `127.0.0.1`
      or `localhost`) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the production project's anon key).
      Pass: both set, and every variable in `.env.example` is present.
- [ ] **Vercel project, server-only secrets**: the same page holds `SUPABASE_SERVICE_ROLE_KEY`,
      `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` and `SITE_URL`, the first
      three marked Sensitive. Pass: every name present; none of them has a `NEXT_PUBLIC_` prefix;
      `SITE_URL` is `<site>`. Values are never copied here.
- [ ] **Portfolio link**: Vercel → the doc-extract project → Settings → Environment Variables →
      Production holds `NEXT_PUBLIC_PORTFOLIO_URL`, the operator's portfolio URL (an `https://`
      address; it is public, so it is not marked Sensitive). A changed value takes effect on the
      next deployment. Pass: the landing page footer on `<site>` shows a Portfolio link to that URL.
- [ ] **Vercel project**: Settings → Git: the production branch is `main`; Settings → Build: the
      framework preset is Next.js. Pass: the latest production deploy was built from `main`.
- [ ] **No secret in the browser**: on `<site>`, open the browser's developer tools, search the
      loaded JavaScript for `service_role`, `sk_test_` and `whsec_`. Pass: none is found.
- [ ] **Edge Function secrets**: `supabase secrets list --project-ref <prod ref>` (or dashboard →
      Edge Functions → Secrets) shows each of `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and
      `CRON_SECRET`. Pass: every name present; `ANTHROPIC_BASE_URL` is `https://api.anthropic.com`;
      `ANTHROPIC_API_KEY` is the production key (see Claude API below), not the dummy local value;
      `CLAUDE_MODEL` is **not** set, so `app_config.model` decides (Lead ruling 4 on #24); no
      Stripe secret is set there (Stripe runs only in Vercel route handlers). The list shows
      digests only; values are never copied here. `process-queue` reads `ANTHROPIC_API_KEY` and
      `ANTHROPIC_BASE_URL` with no default and fails at startup without them (its Logs say
      "ANTHROPIC_API_KEY is not set").
- [ ] **Vault**: SQL editor, `select name from vault.decrypted_secrets where name in
      ('functions_base_url', 'cron_secret')`: the entries the `process-queue` and `purge-files`
      cron jobs read (section 12), created with `select vault.create_secret('<value>', '<name>')`. Pass: both
      names present; `select decrypted_secret from vault.decrypted_secrets where name =
      'functions_base_url'` is `https://<prod ref>.supabase.co/functions/v1` (no trailing slash);
      the Vault `cron_secret` equals the `CRON_SECRET` function secret, which shows as the job's
      calls answering 200, not 401 (see Scheduled jobs). Never copy either value here.
- [ ] **app_config**: SQL editor, `select spend_cap_usd, daily_cap_usd, account_page_cap, model,
      input_usd_per_mtok, output_usd_per_mtok, base_input_tokens, max_input_tokens_per_page,
      max_output_tokens, confidence_threshold, amount_tolerance, extract_concurrency, (select
      count(*) from app_config) as rows from app_config`. Pass: one row; `spend_cap_usd` is 10.00,
      `daily_cap_usd` is 2.00 (OQ-33), `account_page_cap` is 10 (OQ-2), `confidence_threshold` is
      0.80 (OQ-8), `amount_tolerance` is 0.01 (OQ-7), `model` is the model chosen from the latest
      eval run (`claude-sonnet-5-5` until then), and both prices equal Anthropic's current pricing
      page for that model (https://platform.claude.com/docs/en/about-claude/pricing; Sonnet 5.5 was
      2 and 10 USD per million input and output tokens on 2026-10-31). `extract_concurrency` is
      **2** in production (Lead ruling 3 on #24): the migration inserts 1, so set it once with
      `update app_config set extract_concurrency = 2`. `max_output_tokens` and the two input
      settings bound the spend estimate (section 7): keep them at or above the eval's largest
      measured values.
- [ ] **plan_limits**: SQL editor, `select * from plan_limits`. Pass: `free` 20 pages and 0, `pro`
      500 pages and 19.00 (OQ-2, OQ-24).

## Supabase project settings

- [ ] Migrations: production's history matches the repo (`supabase migration list` shows no
      local-only row).
- [ ] Extensions: dashboard → Database → Extensions shows `pgmq`, `pg_cron` and `pg_net` enabled.
- [ ] The `extract` queue: SQL editor, `select queue_name from pgmq.list_queues()`. Pass: `extract`
      is listed (milestone 5's migration creates it). Dashboard → Project Settings → Data API →
      Exposed schemas lists only `public` and `graphql_public`: `pgmq_public` is **not** exposed,
      and the queue is reached only through the `extract_` functions, which only the service role
      may execute (Lead ruling 1 on #24). Pass also: `select has_function_privilege('anon',
      'public.extract_send(uuid)', 'execute'), has_function_privilege('authenticated',
      'public.extract_read(integer, integer)', 'execute')` is `false`, `false`.
- [ ] Auth → URL configuration: the site URL is `<site>`, and the redirect URLs list exactly
      `<site>/auth/callback**`. The `**` is needed because the app returns to
      `/auth/callback?next=<path>` (OQ-34); without it Auth drops the redirect and sends users to
      the site URL. Pass: no entry on `localhost` or `127.0.0.1` (those are only in the local
      `config.toml`), and signing in from `<site>/documents?x=1` while signed out lands on
      `<site>/documents?x=1`.
- [ ] Auth → Providers → Email is **disabled** (OQ-19, OQ-21). The local `config.toml` enables it,
      with a raised email rate limit, for tests only, so it is never pushed to production with
      `supabase config push`. Pass: the provider shows disabled; `<site>/sign-in` offers only
      "Continue with Google" and no email field; and `curl -X POST
      https://<prod ref>.supabase.co/auth/v1/otp -H "apikey: <anon key>" -H
      "Content-Type: application/json" -d
      '{"email":"someone@example.com"}'` is refused (email sign-ins disabled), not answered 200.
- [ ] Auth → Sign In / Providers → "Allow new users to sign up" is **on**: a first Google sign-in
      creates the account (OQ-17). Pass: a Google account that has never signed in gets in.
- [ ] Sign-up trigger: SQL editor, `select tgname, tgenabled from pg_trigger where tgrelid =
      'auth.users'::regclass and tgname = 'on_auth_user_created'`. Pass: one row, `tgenabled` `O`.
      Then `select count(*) from auth.users u where not exists (select 1 from public.profiles p
      where p.id = u.id)` is 0, and so is `select count(*) from public.profiles p where not exists
      (select 1 from public.workspace_members m where m.user_id = p.id and m.role = 'owner')`:
      every user has a profile and owns at least their personal workspace.
- [ ] Auth → no custom SMTP is configured and no captcha is enabled: the app sends no email and has
      no captcha (OQ-19, OQ-33).
- [ ] Storage: dashboard → Storage shows bucket `documents` (**not public**, file size limit 10 MB,
      allowed MIME types `application/pdf`, `image/jpeg`, `image/png`, `image/webp`; OQ-4) and
      bucket `demo` (**not public**, the same limits; read through its select policy
      `demo_objects_select` only, with no insert, update or delete policy). Pass: opening a `documents`
      or `demo` object URL without a signed token returns an error.
- [ ] Storage: the `demo` bucket holds one file per published `demo_documents` row (`select slug,
      file_path from demo_documents where published`). Pass: every sample's file opens on its
      `/demo/<slug>` page while signed out.
- [ ] Storage policies on `documents` (section 5): SQL editor, `select policyname, cmd, roles from
      pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like
      'documents_objects_%' order by policyname`. Pass: exactly `documents_objects_insert` (INSERT,
      `{authenticated}`) and `documents_objects_select` (SELECT, `{authenticated}`), and no other
      policy on `storage.objects` names `documents`: there is no client update or delete.
- [ ] Realtime: dashboard → Database → Publications → `supabase_realtime` includes `documents`;
      or SQL editor, `select tablename from pg_publication_tables where pubname =
      'supabase_realtime'`. Pass: `documents` is listed (section 4.3, OQ-35).
- [ ] Security advisors show no open finding (dashboard → Advisors → Security), in particular no
      table without RLS and no `security definer` function with a mutable search path.
- [ ] Function grants: SQL editor, `select has_function_privilege('anon',
      'public.get_plan_limits()', 'execute'), has_function_privilege('anon',
      'public.get_budget_status()', 'execute')`. Pass: `true`, `false` (OQ-27, OQ-22).
- [ ] Backups: the plan's backups are on. Uploaded files are deleted after 7 days by design, so
      point-in-time recovery is not needed for them.

## Upload

Milestone 4: the browser creates a document, uploads its file to the `documents` bucket and posts
it to the `submit-document` Edge Function, which counts its pages and reserves them (sections 2,
5, 6.1 and 7).

- [ ] `submit-document` is deployed from the release's commit: `supabase functions deploy
      submit-document --project-ref <prod ref>`. Dashboard → Edge Functions lists
      `submit-document` with "Enforce JWT verification" on. It reads only `SUPABASE_URL`,
      `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase provides to every
      function, so it needs no secret of its own. Pass: the function is listed with the release's
      deploy time, and `curl -X POST https://<prod ref>.supabase.co/functions/v1/submit-document`
      with no `Authorization` header is refused with 401.
- [ ] Account cap: SQL editor, `select account_page_cap from app_config` and `select
      public.account_page_cap()`. Pass: both 10 (OQ-2). Since milestone 5 the function reads
      `app_config.account_page_cap`, so the operator changes the cap with `update app_config set
      account_page_cap = <n>`, and null turns it off, without a release.
- [ ] Pass: signed in on `<site>/documents`, the upload control says "Files are deleted 7 days
      after upload." and shows the account's and the workspace's pages left. Uploading a one-page
      PDF lists it as "Queued" with 1 page; a 20 MB file and a `.txt` file are refused before
      upload. With the same workspace open in a second window, the new document appears there
      within 5 seconds, without a reload (OQ-35).

## Extraction

Milestone 5: `submit-document` sends each accepted document to the pgmq queue `extract`; a pg_cron
job posts to `process-queue` every 10 seconds, which reserves spend, calls Claude and stores the
result (sections 6.1, 6.3, 6.4, 7 and 9).

- [ ] `submit-document` is redeployed from the release's commit (it now sends to the queue):
      `supabase functions deploy submit-document --project-ref <prod ref>`, with "Enforce JWT
      verification" on. Pass: Dashboard → Edge Functions shows it with the release's deploy time.
- [ ] `process-queue` is deployed from the release's commit **without JWT verification**, because
      pg_cron calls it with `CRON_SECRET`, not a user's JWT: `supabase functions deploy
      process-queue --no-verify-jwt --project-ref <prod ref>`. Pass: Dashboard → Edge Functions
      lists `process-queue` with "Enforce JWT verification" off and the release's deploy time, and
      `curl -X POST https://<prod ref>.supabase.co/functions/v1/process-queue` with no
      `x-cron-secret` header is answered 401.
- [ ] Pass: signed in on `<site>/documents`, upload a one-page sample invoice. Within a minute it
      goes Queued → Processing → "Needs review" with type Invoice, without a reload; SQL editor,
      `select outcome, model, cost_usd from extractions order by created_at desc limit 1` shows
      `ok`, `claude-sonnet-5-5` and a cost of a few cents. Upload a photo that is not a business
      document: it reaches "Not supported" with a reason, and `account_page_usage` for the account
      is unchanged by it (OQ-1).
- [ ] Pass: a "Failed" document shows its reason and a Retry button; Retry puts it back to
      "Queued" (`select kind from document_events where document_id = '<id>'` shows `retried`).

## Review, approval and delete

Milestone 7: the review screen corrects fields through RLS and the review RPCs, approves through
the `approve-document` Edge Function, and deletes a document through `DELETE /api/documents/[id]`,
a Vercel route handler that uses `SUPABASE_SERVICE_ROLE_KEY` (sections 4.1, 5, 6.1 and 6.2).

- [ ] `approve-document` is deployed from the release's commit **with** JWT verification:
      `supabase functions deploy approve-document --project-ref <prod ref>`. It reads only
      `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase provides,
      so it needs no secret of its own. Pass: Dashboard → Edge Functions lists `approve-document`
      with "Enforce JWT verification" on and the release's deploy time, and `curl -X POST
      https://<prod ref>.supabase.co/functions/v1/approve-document` with no `Authorization` header
      is refused with 401.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set in Vercel's Production environment (see Environment and
      secrets): the delete route now reads it. Pass: deleting a document on `<site>` succeeds;
      without the key the route answers 500 and Vercel's function log says
      "SUPABASE_SERVICE_ROLE_KEY is not set".
- [ ] Pass: signed in on `<site>`, open a document in "Needs review" from the list. Its file is
      shown (every page of a PDF), and zoom in and out work. Correct a field: the original value
      stays shown beside it, the checks change without a reload, and the correction is still there
      after a reload. Tick each failed check, approve, and see "Approved by <you> on <time>";
      Reopen puts it back to "Needs review", and the History lists the reopen above the approval.
- [ ] Pass: delete a document from the list after its confirmation. It leaves the list, its review
      URL says "This document does not exist", Storage → `documents` no longer holds
      `<workspace>/<document>/original`, and `select pages_used from page_usage` is the same as
      before (PRD US-19.1 AC-4).

## Retention and the budget line

Milestone 10: a pg_cron job posts to the `purge-files` Edge Function daily at 03:00 UTC, which
removes the files of documents 7 days old, the uploads left for an hour (giving their pages back)
and the spend reservations a killed run left; a second job deletes pg_cron's run log older than 7
days; the document list shows the AI budget from `get_budget_status()` (sections 7 and 8;
OQ-14, OQ-22, OQ-23, OQ-39). Nothing new is secret: the job reuses the `CRON_SECRET` function
secret and the two Vault entries `process-queue` already reads (Environment and secrets above).

- [ ] `purge-files` is deployed from the release's commit **without JWT verification**, because
      pg_cron calls it with `CRON_SECRET`, not a user's JWT: `supabase functions deploy
      purge-files --no-verify-jwt --project-ref <prod ref>`. Pass: Dashboard → Edge Functions
      lists `purge-files` with "Enforce JWT verification" off and the release's deploy time, and
      `curl -X POST https://<prod ref>.supabase.co/functions/v1/purge-files` with no
      `x-cron-secret` header is answered 401 (and removes nothing).
- [ ] The jobs are present after the migration `20261101031050_retention_budget.sql`: SQL editor,
      `select jobname, schedule, active, command like '%/purge-files%' as calls_purge from cron.job
      where jobname in ('purge-files', 'cron-history-cleanup') order by jobname`. Pass: two rows,
      both `active`; `cron-history-cleanup` at `30 3 * * *` with `calls_purge` false;
      `purge-files` at `0 3 * * *` with `calls_purge` true.
- [ ] A run's result, after 03:00 UTC: SQL editor, `select d.status, d.return_message,
      d.start_time from cron.job_run_details d join cron.job j using (jobid) where j.jobname =
      'purge-files' order by d.start_time desc limit 3`. Pass: one row a day, `succeeded`. That
      row says only that the request was sent; the function's answer is in `select status_code,
      content, created from net._http_response where content like '%files_removed%' order by id
      desc limit 1`, which pg_net keeps for about 6 hours, so check before 09:00 UTC. Pass:
      `status_code` 200 and `content` such as `{"files_removed":3,"files_failed":0,
      "stale_uploads_removed":0,"reservations_released":0}`, with `files_failed` 0; a 401 means the
      Vault `cron_secret` and the `CRON_SECRET` function secret differ. Edge Functions →
      `purge-files` → Logs shows the same invocation answered 200, with no "could not remove" line.
- [ ] Nothing older is left: SQL editor, `select count(*) from documents where created_at < now() -
      interval '8 days' and file_deleted_at is null` (Pass: 0), `select count(*) from documents
      where status = 'uploading' and created_at < now() - interval '1 day'` (Pass: 0), and `select
      count(*) from ai_spend_reservations where settled_at is null and created_at < now() -
      interval '1 day'` (Pass: 0).
- [ ] The cron log is trimmed: SQL editor, `select count(*) from cron.job_run_details where
      start_time < now() - interval '8 days'`. Pass: 0, once the job has run.
- [ ] The demo's files stay: the Demo item's query below still shows seven rows with `uploaded`
      true after a purge run (US-14.1 AC-3).
- [ ] Pass: signed in on `<site>/documents`, the upload area shows "$x of $10 used this month",
      where x is `select round(spent_usd, 2) from ai_spend_periods where period_start =
      date_trunc('month', now() at time zone 'utc')::date` (or $0.00 with no row). It adds "Today's
      AI limit is reached…" or "This month's AI limit is reached…" only while a limit is reached.
      `get_budget_status()` answers signed-in users only, so the SQL editor, which has no user,
      gets "sign in to see the AI budget" from it.
- [ ] Pass: in a private window, signed out, `<site>` and `<site>/demo` work, and the browser's
      network panel shows no request to `get_budget_status`.

## Demo

Milestone 11: `/demo` and `/demo/<slug>` show seven fictitious samples on the review screen, read
as anon from `demo_documents` and the private `demo` bucket (sections 4.2, 5 and 10). The rows
arrive with the migration `20261031193713_demo.sql`; the files do not, so the operator uploads them
once (Lead ruling 2 on #41).

- [ ] **Upload the sample files**: from the release's commit, upload the seven files in the repo
      folder `demo/samples/` to the production `demo` bucket, each at its own name, which is its
      `file_path` (`invoice-total-mismatch.pdf`, `invoice-duplicate.pdf`, `receipt-photo.png`,
      `bank-statement.pdf`, `purchase-order.pdf`, `delivery-note.pdf`, `quote-date-error.pdf`):
      dashboard → Storage → `demo` → Upload files, at the bucket's top level, no folder. Never
      run `npm run demo:upload` for this: it refuses any stack but the local one. Where to check:
      SQL editor, `select d.file_path, o.name is not null as uploaded from demo_documents d left
      join storage.objects o on o.bucket_id = 'demo' and o.name = d.file_path where d.published
      order by d.sort_order`. Pass: seven rows, every `uploaded` true; the bucket shows **not
      public** with a 10 MB limit; and in a private window, signed out, `<site>/demo` lists the
      seven samples and each `<site>/demo/<slug>` shows its document (both pages of the bank
      statement, the receipt photo) beside its fields, with no "could not be shown" message.
- [ ] Pass: on `<site>/demo/invoice-total-mismatch`, signed out, check A3 is Failed; correcting
      Total to 303.43 makes it pass; Export → CSV downloads a zip whose `documents.csv` has total
      303.43; a reload shows 313.43 again; and `select spent_usd, reserved_usd from
      ai_spend_periods order by period_start desc limit 1` is the same before and after (F13 AC-4).

## Google sign-in

Google is the only sign-in method (OQ-19, OQ-21).

- [ ] Google Cloud Console → APIs & Services → Credentials: the OAuth 2.0 client (type Web
      application) lists `https://<prod ref>.supabase.co/auth/v1/callback` as an authorised
      redirect URI, and `<site>` as an authorised JavaScript origin. Pass: exactly that redirect
      URI, no `localhost` entry on the production client (local development uses its own client,
      whose id and secret are in the gitignored `supabase/.env`).
- [ ] Google Cloud Console → OAuth consent screen: publishing status is **In production** (not
      Testing, which only admits listed test users), the app name and support email are set, the
      home page is `<site>` and the privacy policy link is `<site>/privacy`. The scopes are only
      `openid`, `email` and `profile`. Pass: the consent screen shows the app name and asks for
      nothing beyond name, email and profile picture.
- [ ] Supabase → Auth → Providers → Google is enabled with that client's id and secret (secret
      stored only there; never in the repo or in Vercel), and "Skip nonce checks" is off. Pass: the
      client id shown matches the Google Cloud client's.
- [ ] Pass: in a private window, opening `<site>/documents` goes to `<site>/sign-in?next=%2Fdocuments`;
      "Continue with Google" with an account that is not a test user returns to
      `<site>/documents`, signed in, with the workspace switcher showing "Personal", of which the
      user is owner (OQ-17, OQ-34). "Sign out" ends the session: opening `<site>/documents` again
      goes back to sign-in.

## Site address

- [ ] `<site>` loads over HTTPS, and a deep link such as `<site>/demo` loads its page, not a 404.
- [ ] The landing page links to the repo and to the operator's portfolio, and shows the plans and
      their page limits while signed out (OQ-27).
- [ ] `<site>/privacy` and `<site>/terms` load while signed out (OQ-30).

## Invitation links

An owner's invitation is a link `<site>/invite/<token>`, shown once and passed on by hand; the app
sends no email (OQ-19). The server builds it from `SITE_URL` (section 12), so a wrong value hands
out links to the wrong place, and an unset one makes creating an invitation fail.

- [ ] Vercel → the doc-extract project → Settings → Environment Variables → Production:
      `SITE_URL` is exactly `<site>`: `https://`, the production address, no path, and not a
      preview or per-deployment `*.vercel.app` address, `localhost` or `127.0.0.1`. A changed value
      takes effect on the next deployment. Pass: the value shown is `<site>`.
- [ ] Pass: signed in on `<site>` as the owner of a test workspace, open the workspace menu →
      Members → Invite, enter a Google address you control, and Create link. The link shown starts
      with `<site>/invite/`. Open it in a private window: it goes to
      `<site>/sign-in?next=%2Finvite%2F…`; "Continue with Google" as that address returns to the
      invitation (this relies on the `<site>/auth/callback**` redirect URL above), and "Accept
      invitation" lands on `<site>/documents` with the test workspace current. Then remove the
      test member on the Members page.

## Claude API

- [ ] Anthropic Console → Settings → Limits (for the workspace that holds the production key):
      the monthly spend limit is **$10**. Pass: the limit page shows $10 for the current month.
- [ ] Anthropic Console → API keys: the key stored as `ANTHROPIC_API_KEY` belongs to that
      workspace and is used by nothing else; the eval runs on the operator's own laptop key, not
      this one (OQ-26). Pass: the key's name matches, and usage for the month matches
      `ai_spend_periods` within a few cents.
- [ ] Spend ledger: SQL editor, `select * from ai_spend_periods order by period_start desc limit
      1` and `select * from ai_spend_days order by day desc limit 1`. Pass: `cap_usd` is 10.00 and
      2.00 respectively, and in each row `spent_usd + reserved_usd` is at most `cap_usd`.
- [ ] Waiting work: SQL editor, `select count(*) from documents where status = 'waiting_budget'`.
      Pass: 0, unless the document list's budget line on `<site>/documents` says the daily
      ceiling or the monthly cap is reached (OQ-23).

## Payments (Stripe, test mode only)

This app takes **no real payments**. Every item here checks that only test mode is in use.

- [ ] `STRIPE_SECRET_KEY` in Vercel is a **test** key (`sk_test_…`); no live key (`sk_live_…` or
      `rk_live_…`) is set anywhere. Pass: Stripe dashboard → Developers → API keys, with "Test
      mode" on, shows the key whose last four characters match. A key that does not start with
      `sk_test_` stops the server (`src/instrumentation.ts`, section 6.2): every page and route,
      the landing page and the demo included, answers 500, and Vercel's function log says
      "STRIPE_SECRET_KEY does not start with sk_test_". An unset key does not stop the server: the
      demo and the landing page work, and only the billing calls fail.
- [ ] Stripe dashboard (test mode) → Products: the Pro product has a recurring price of **$19 a
      month in USD** with no trial (OQ-24); its price id is the one in `STRIPE_PRICE_PRO`. Pass:
      SQL editor, `select monthly_price_usd from plan_limits where plan = 'pro'` is the same 19.00,
      which is what the billing and landing pages show.
- [ ] Stripe dashboard (test mode) → Developers → Webhooks: an endpoint for
      `<site>/api/stripe/webhook` is registered for exactly `checkout.session.completed`,
      `customer.subscription.updated` and `customer.subscription.deleted`, and its signing secret
      is the one in `STRIPE_WEBHOOK_SECRET`. Pass: any other type the endpoint receives is only
      acknowledged, so the list holds those three; a delivery answered 400 means the secret differs.
- [ ] Stripe dashboard (test mode) → Developers → Webhooks → the endpoint → API version: it is
      `2026-10-28.endive`, the version `src/lib/stripe.ts` pins. An endpoint's events use the
      version it was created with, and the webhook reads the period end from the subscription's
      item (`items.data[0].current_period_end`), where this version places it. Pass: the version
      shown matches, and after an upgrade `select plan_period_end from workspaces where id = '<the
      workspace>'` is not null.
- [ ] Stripe dashboard (test mode) → Settings → Billing → Customer portal is activated with
      cancellation at the end of the billing period allowed (OQ-37). Pass: "Manage or cancel" on
      `<site>/billing` opens the portal, and it offers cancelling at the end of the period, not at
      once.
- [ ] Pass: signed in on `<site>/billing` as an owner on Free, Upgrade opens Checkout at $19 a month.
      One upgrade with the test card `4242 4242 4242 4242` returns to the billing page and turns the
      workspace into Pro within 10 seconds of the webhook (OQ-36), without a reload; the webhook
      endpoint shows the delivery as succeeded; and SQL editor, `select type, processed_at from
      stripe_events order by received_at desc limit 5` shows it with `processed_at` set. Cancelling
      through the portal shows "Your Pro plan ends on <date>" on the billing page, and the workspace
      returns to Free at the period end (OQ-24, OQ-37).
- [ ] Pass: SQL editor, `select count(*) from stripe_events where processed_at is null and
      received_at < now() - interval '1 day'` is 0. A row left unprocessed is an event whose
      processing failed on every retry (Vercel's function log says "could not be processed").

## Scheduled jobs

- [ ] SQL editor, `select jobname, schedule, active from cron.job`. Pass: `process-queue` (every 10
      seconds), `purge-files` (daily at 03:00 UTC) and `cron-history-cleanup` (daily at 03:30 UTC)
      are listed and `active`.
- [ ] `process-queue` job runs reach the function: SQL editor, `select status_code, content,
      error_msg, created from net._http_response order by id desc limit 10`. Pass: recent rows are
      200 with `{"outcome": …}`; a 401 means the Vault `cron_secret` and the `CRON_SECRET` function
      secret differ, a 404 or "Couldn't resolve host name" a wrong `functions_base_url`. The job
      sends `app_config.extract_concurrency` requests per run, so 0 there pauses extraction.
- [ ] SQL editor, `select jobname, status, start_time from cron.job_run_details d join cron.job j
      using (jobid) order by start_time desc limit 20`. Pass: recent runs of both jobs show
      `succeeded`.
- [ ] Edge Functions → `process-queue` and `purge-files` → Logs: recent invocations return 200 (a
      401 means the cron job's `CRON_SECRET` does not match the function's).
- [ ] Retention (OQ-14, OQ-39): SQL editor, `select count(*) from documents where created_at <
      now() - interval '8 days' and file_deleted_at is null`. Pass: 0.
- [ ] Queue: SQL editor, `select * from pgmq.metrics('extract')`. Pass: the oldest message is less
      than 10 minutes old, unless documents are waiting for budget (no stuck queue).

## After every deploy (automated once the smoke test exists)

- [ ] The production site loads with no console errors, and "Continue with Google" signs in.
- [ ] Production runs the commit that was meant to ship (Vercel → Deployments: the production
      deploy's commit is the release's).
- [ ] The demo opens from the landing page in one click, every sample shows its stored result,
      and `ai_spend_periods.spent_usd` is unchanged afterwards (the demo makes no Claude calls).
- [ ] One real upload of a one-page sample invoice reaches "Needs review" with its type detected
      as invoice, while the daily ceiling and the monthly cap are not reached.

## Rollback

- [ ] How to go back: in Vercel → Deployments, promote the previous production deploy; redeploy
      the previous release's Edge Functions with `supabase functions deploy` from that commit.
      Migrations only move forward: a migration that needs undoing gets a new follow-up migration,
      named in the release notes.
