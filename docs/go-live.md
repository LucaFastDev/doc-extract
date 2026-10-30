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
refer to it. Items marked (OQ-n) depend on an open question in [PRD.md](PRD.md) and are finished
when it is answered.

## Last full run

| Date | Who | Release or commit | Result |
|---|---|---|---|
| | | | |

## Environment and secrets

- [ ] **Vercel project**: Vercel → the doc-extract project → Settings → Environment Variables →
      Production holds `VITE_SUPABASE_URL` (the production project's URL, not `127.0.0.1` or
      `localhost`) and `VITE_SUPABASE_ANON_KEY` (the production project's anon key). Pass: both
      set, and every variable in `.env.example` is present.
- [ ] **Vercel project**: Settings → Git: the production branch is `main`; Settings → Build: the
      framework preset is Vite and the output directory is `dist`. Pass: the latest production
      deploy was built from `main`.
- [ ] **Edge Function secrets**: `supabase secrets list --project-ref <prod ref>` (or dashboard →
      Edge Functions → Secrets) shows each of `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`,
      `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `SITE_URL`, `CRON_SECRET`.
      Pass: every name present; `ANTHROPIC_BASE_URL` is `https://api.anthropic.com`; `SITE_URL` is
      the production domain. The list shows digests only; values are never copied here.
- [ ] **Vault**: SQL editor, `select name from vault.decrypted_secrets` lists the functions' base
      URL and `CRON_SECRET` entries the cron jobs read (section 12). Pass: both names present, and
      the Vault `CRON_SECRET` matches the function secret (a cron run succeeds, see Scheduled jobs).
- [ ] **app_config**: SQL editor, `select spend_cap_usd, model, input_usd_per_mtok,
      output_usd_per_mtok from app_config`. Pass: `spend_cap_usd` is 10.00, `model` is the model
      chosen from the latest eval run, and both prices equal Anthropic's current pricing page for
      that model.

## Supabase project settings

- [ ] Migrations: production's history matches the repo (`supabase migration list` shows no
      local-only row).
- [ ] Extensions: dashboard → Database → Extensions shows `pgmq`, `pg_cron` and `pg_net` enabled.
- [ ] Auth → URL configuration: the site URL is the production domain, and the redirect URLs allow
      the production domain's sign-in callback and invite-acceptance routes (and nothing on
      `localhost`).
- [ ] Auth → Providers → Email is enabled with the sign-in method chosen in OQ-21.
- [ ] Auth → email templates and SMTP sender are the production ones, not the defaults: custom
      SMTP is configured with the provider chosen in OQ-19. Pass: a sign-in email reaches an
      address outside the Supabase team.
- [ ] Auth → Rate limits and sign-up protection match OQ-33.
- [ ] Storage: dashboard → Storage shows bucket `documents` (**not public**, file size limit and
      allowed MIME types as OQ-4 sets) and bucket `demo` (public read). Pass: opening a
      `documents` object URL without a signed token returns an error.
- [ ] Storage: the `demo` bucket holds one file per published `demo_documents` row (`select slug,
      file_path from demo_documents where published`). Pass: every `file_path` opens.
- [ ] Realtime: dashboard → Database → Publications → `supabase_realtime` includes `documents`.
- [ ] Security advisors show no open finding (dashboard → Advisors → Security), in particular no
      table without RLS and no `security definer` function with a mutable search path.
- [ ] Backups: the plan's backups are on. Uploaded files are deleted after 7 days by design, so
      point-in-time recovery is not needed for them.

## Google sign-in

- [ ] Google Cloud Console → APIs & Services → Credentials: the OAuth 2.0 client (type Web
      application) lists `https://<prod ref>.supabase.co/auth/v1/callback` as an authorised
      redirect URI.
- [ ] Google Cloud Console → OAuth consent screen: publishing status is **In production** (not
      Testing, which only admits listed test users), the app name and support email are set, and
      the authorised domain includes the production domain.
- [ ] Supabase → Auth → Providers → Google is enabled with that client's id and secret (secret
      stored only there).
- [ ] Pass: signing in with a Google account that is not a test user lands signed in on the
      production site.

## Domain

- [ ] The production domain (OQ-27) is added in Vercel → Settings → Domains, resolves, the
      certificate is valid, and the bare and `www` forms end on the same URL.
- [ ] A deep link such as `https://<domain>/demo` loads the app, not a 404 (single-page-app
      rewrite in `vercel.json`).

## Email

- [ ] The sending domain of the provider chosen in OQ-19 is verified (SPF and DKIM pass; DMARC
      set).
- [ ] A real email of each kind the app sends (sign-in, invitation) arrives at the operator's own
      address, **not in spam**, and its links open the production site.

## Claude API

- [ ] Anthropic Console → Settings → Limits (for the workspace that holds the production key):
      the monthly spend limit is **$10**. Pass: the limit page shows $10 for the current month.
- [ ] Anthropic Console → API keys: the key stored as `ANTHROPIC_API_KEY` belongs to that
      workspace and is used by nothing else (the eval uses its own key or the operator's choice in
      OQ-26). Pass: the key's name matches, and usage for the month matches `ai_spend_periods`
      within a few cents.
- [ ] Spend ledger: SQL editor, `select * from ai_spend_periods order by period_start desc limit
      1`. Pass: `cap_usd` is 10.00 and `spent_usd + reserved_usd` is at most `cap_usd`.

## Payments (Stripe, test mode only)

This app takes **no real payments**. Every item here checks that only test mode is in use.

- [ ] `STRIPE_SECRET_KEY` in the Edge Function secrets is a **test** key (`sk_test_…`); no live key
      (`sk_live_…`) is set anywhere. Pass: Stripe dashboard → Developers → API keys, with "Test
      mode" on, shows the key whose last four characters match; the functions refuse a live key
      at startup (section 6.1), so a wrong key shows as every billing call failing.
- [ ] Stripe dashboard (test mode) → Products: the Pro product and price exist; its price id is
      the one in `STRIPE_PRICE_PRO`.
- [ ] Stripe dashboard (test mode) → Developers → Webhooks: an endpoint for
      `https://<prod ref>.supabase.co/functions/v1/stripe-webhook` is registered for
      `checkout.session.completed`, `customer.subscription.updated` and
      `customer.subscription.deleted`, and its signing secret is the one in
      `STRIPE_WEBHOOK_SECRET`.
- [ ] Stripe dashboard (test mode) → Settings → Billing → Customer portal is activated with
      cancellation allowed.
- [ ] One upgrade with the test card `4242 4242 4242 4242` turns a Free workspace into Pro within
      10 seconds, the webhook endpoint shows the delivery as succeeded, and cancelling it through
      the portal returns the workspace to Free at the period end.

## Scheduled jobs

- [ ] SQL editor, `select jobname, schedule, active from cron.job`. Pass: `process-queue` (every 10
      seconds) and `purge-files` (daily at 03:00 UTC) are listed and `active`.
- [ ] SQL editor, `select jobname, status, start_time from cron.job_run_details d join cron.job j
      using (jobid) order by start_time desc limit 20`. Pass: recent runs of both jobs show
      `succeeded`.
- [ ] Edge Functions → `process-queue` and `purge-files` → Logs: recent invocations return 200 (a
      401 means the cron job's `CRON_SECRET` does not match the function's).
- [ ] Retention: SQL editor, `select count(*) from documents where created_at < now() - interval
      '8 days' and file_deleted_at is null`. Pass: 0.
- [ ] Queue: SQL editor, `select * from pgmq.metrics('extract')`. Pass: the oldest message is less
      than 10 minutes old (no stuck queue).

## After every deploy (automated once the smoke test exists)

- [ ] The production site loads with no console errors, and the sign-in page works.
- [ ] Production runs the commit that was meant to ship (Vercel → Deployments: the production
      deploy's commit is the release's).
- [ ] The demo opens from the landing page in one click, every sample shows its stored result,
      and `ai_spend_periods.spent_usd` is unchanged afterwards (the demo makes no Claude calls).
- [ ] One real upload of a one-page sample invoice reaches "Needs review" with fields, while the
      spend cap is not reached.

## Rollback

- [ ] How to go back: in Vercel → Deployments, promote the previous production deploy; redeploy
      the previous release's Edge Functions with `supabase functions deploy` from that commit.
      Migrations only move forward: a migration that needs undoing gets a new follow-up migration,
      named in the release notes.
