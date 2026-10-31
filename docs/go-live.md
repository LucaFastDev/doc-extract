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
- [ ] **Vercel project**: Settings → Git: the production branch is `main`; Settings → Build: the
      framework preset is Next.js. Pass: the latest production deploy was built from `main`.
- [ ] **No secret in the browser**: on `<site>`, open the browser's developer tools, search the
      loaded JavaScript for `service_role`, `sk_test_` and `whsec_`. Pass: none is found.
- [ ] **Edge Function secrets**: `supabase secrets list --project-ref <prod ref>` (or dashboard →
      Edge Functions → Secrets) shows each of `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and
      `CRON_SECRET`. Pass: every name present; `ANTHROPIC_BASE_URL` is `https://api.anthropic.com`;
      no Stripe secret is set there (Stripe runs only in Vercel route handlers). The list shows
      digests only; values are never copied here.
- [ ] **Vault**: SQL editor, `select name from vault.decrypted_secrets` lists the functions' base
      URL and `CRON_SECRET` entries the cron jobs read (section 12). Pass: both names present, and
      the Vault `CRON_SECRET` matches the function secret (a cron run succeeds, see Scheduled jobs).
- [ ] **app_config**: SQL editor, `select spend_cap_usd, daily_cap_usd, account_page_cap, model,
      input_usd_per_mtok, output_usd_per_mtok, confidence_threshold, amount_tolerance from
      app_config`. Pass: `spend_cap_usd` is 10.00, `daily_cap_usd` is 2.00 (OQ-33),
      `account_page_cap` is 10 (OQ-2), `confidence_threshold` is 0.80 (OQ-8), `amount_tolerance` is
      0.01 (OQ-7), `model` is the model chosen from the latest eval run, and both prices equal
      Anthropic's current pricing page for that model.
- [ ] **plan_limits**: SQL editor, `select * from plan_limits`. Pass: `free` 20 pages and 0, `pro`
      500 pages and 19.00 (OQ-2, OQ-24).

## Supabase project settings

- [ ] Migrations: production's history matches the repo (`supabase migration list` shows no
      local-only row).
- [ ] Extensions: dashboard → Database → Extensions shows `pgmq`, `pg_cron` and `pg_net` enabled.
- [ ] Auth → URL configuration: the site URL is `<site>`, and the redirect URLs allow
      `<site>/auth/callback` (and nothing on `localhost`).
- [ ] Auth → Providers → Email is **disabled** (OQ-19, OQ-21). The local `config.toml` enables it
      for tests only, so it is never pushed to production with `supabase config push`. Pass: the
      provider shows disabled, and `<site>/sign-in` offers only "Continue with Google".
- [ ] Auth → no custom SMTP is configured and no captcha is enabled: the app sends no email and has
      no captcha (OQ-19, OQ-33).
- [ ] Storage: dashboard → Storage shows bucket `documents` (**not public**, file size limit 10 MB,
      allowed MIME types `application/pdf`, `image/jpeg`, `image/png`, `image/webp`; OQ-4) and
      bucket `demo` (**not public**; read through its select policy). Pass: opening a `documents`
      or `demo` object URL without a signed token returns an error.
- [ ] Storage: the `demo` bucket holds one file per published `demo_documents` row (`select slug,
      file_path from demo_documents where published`). Pass: every sample's file opens on its
      `/demo/<slug>` page while signed out.
- [ ] Realtime: dashboard → Database → Publications → `supabase_realtime` includes `documents`.
- [ ] Security advisors show no open finding (dashboard → Advisors → Security), in particular no
      table without RLS and no `security definer` function with a mutable search path.
- [ ] Function grants: SQL editor, `select has_function_privilege('anon',
      'public.get_plan_limits()', 'execute'), has_function_privilege('anon',
      'public.get_budget_status()', 'execute')`. Pass: `true`, `false` (OQ-27, OQ-22).
- [ ] Backups: the plan's backups are on. Uploaded files are deleted after 7 days by design, so
      point-in-time recovery is not needed for them.

## Google sign-in

Google is the only sign-in method (OQ-19, OQ-21).

- [ ] Google Cloud Console → APIs & Services → Credentials: the OAuth 2.0 client (type Web
      application) lists `https://<prod ref>.supabase.co/auth/v1/callback` as an authorised
      redirect URI.
- [ ] Google Cloud Console → OAuth consent screen: publishing status is **In production** (not
      Testing, which only admits listed test users), the app name and support email are set, the
      home page is `<site>` and the privacy policy link is `<site>/privacy`.
- [ ] Supabase → Auth → Providers → Google is enabled with that client's id and secret (secret
      stored only there).
- [ ] Pass: signing in with a Google account that is not a test user lands signed in on `<site>`,
      with a personal workspace (OQ-17).

## Site address

- [ ] `<site>` loads over HTTPS, and a deep link such as `<site>/demo` loads its page, not a 404.
- [ ] The landing page links to the repo and to the operator's portfolio, and shows the plans and
      their page limits while signed out (OQ-27).
- [ ] `<site>/privacy` and `<site>/terms` load while signed out (OQ-30).

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
      Pass: 0, unless `get_budget_status()` reports the daily ceiling or the monthly cap reached
      (OQ-23).

## Payments (Stripe, test mode only)

This app takes **no real payments**. Every item here checks that only test mode is in use.

- [ ] `STRIPE_SECRET_KEY` in Vercel is a **test** key (`sk_test_…`); no live key (`sk_live_…`) is
      set anywhere. Pass: Stripe dashboard → Developers → API keys, with "Test mode" on, shows the
      key whose last four characters match; the server refuses a live key at startup (section
      6.2), so a wrong key shows as every billing call failing.
- [ ] Stripe dashboard (test mode) → Products: the Pro product has a recurring price of **$19 a
      month in USD** with no trial (OQ-24); its price id is the one in `STRIPE_PRICE_PRO`.
- [ ] Stripe dashboard (test mode) → Developers → Webhooks: an endpoint for
      `<site>/api/stripe/webhook` is registered for `checkout.session.completed`,
      `customer.subscription.updated` and `customer.subscription.deleted`, and its signing secret
      is the one in `STRIPE_WEBHOOK_SECRET`.
- [ ] Stripe dashboard (test mode) → Settings → Billing → Customer portal is activated with
      cancellation at the end of the billing period allowed (OQ-37).
- [ ] One upgrade with the test card `4242 4242 4242 4242` turns a Free workspace into Pro within
      10 seconds (OQ-36), the webhook endpoint shows the delivery as succeeded, and cancelling it
      through the portal returns the workspace to Free at the period end (OQ-24, OQ-37).

## Scheduled jobs

- [ ] SQL editor, `select jobname, schedule, active from cron.job`. Pass: `process-queue` (every 10
      seconds) and `purge-files` (daily at 03:00 UTC) are listed and `active`.
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
