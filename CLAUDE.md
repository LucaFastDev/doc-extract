# doc-extract

Upload business documents (invoices, receipts, bank statements, purchase orders, delivery notes and
quotes), get checked structured data out. Requirements are in `docs/PRD.md`, the design in
`docs/ARCHITECTURE.md`, and what production needs in `docs/go-live.md`.

Stack: Next.js (App Router), TypeScript, Tailwind, shadcn/ui on Vercel; Supabase (Postgres with
RLS, Auth, Storage, Realtime, pgmq, pg_cron, pg_net, Edge Functions); Vitest and Playwright.

Next.js here is version 16, which may differ from what you know: read the guide for what you
are changing in `node_modules/next/dist/docs/` first, and heed deprecation notices.

## Commands

| What | Command |
|---|---|
| Dev server | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit tests | `npm test` |
| Local stack | `npx supabase start`, `npx supabase stop` |
| Replay migrations and seed | `npx supabase db reset` |
| Access tests (local stack, after a reset) | `npm run test:access` |
| Build | `npm run build` |
| End-to-end tests | `npm run test:e2e` |

`.env.local` holds the local stack's values from `npx supabase status` (see `.env.example`); it is
gitignored and copied into worktrees by `.worktreeinclude`. Never put a production value in it.

There are no generators here: write files by hand (no `create-next-app`, `shadcn` CLI or
`supabase migration new`), and run Next.js through the `npm run` scripts. A migration is a
hand-named file `supabase/migrations/<UTC yyyymmddhhmmss>_<name>.sql`.

## Layout

- `src/app/` App Router pages and route handlers; `layout.tsx` imports `globals.css`
- `src/app/globals.css` design tokens (CSS variables on `:root`, shadcn/ui layout), consumed by
  Tailwind
- `src/lib/supabase/client.ts` the browser client; `src/lib/supabase/server.ts` the server client
  (`import 'server-only'`)
- `src/lib/utils.ts` shadcn/ui's `cn`; `components.json` shadcn/ui's settings
- `supabase/` `config.toml` (local stack only), forward-only `migrations/`, `seed.sql`,
  `functions/` (each function's checks in pure modules with `*.test.ts` beside them, run by
  `npm test`; `supabase start` serves the functions present when it starts)
- `shared/` plain TypeScript with no imports, read by Next.js as `@shared/*` and by the functions
  by relative import (`limits.ts`: accepted types, 10 MB, 10 pages, 10 files)
- `tests/access/` Vitest access tests against the local stack (`vitest.access.config.ts`)
- `e2e/` Playwright specs; `playwright.config.ts` picks one port per checkout from `E2E_PORT`
- `.github/workflows/ci.yml` CI on GitHub's hosted runners: typecheck, lint, unit tests,
  `supabase db reset`, access tests, build and end-to-end tests

## Rules

- **Claude is mocked** in every test, locally and in CI. No test calls the Claude API.
- **No production URLs or keys** in code, tests or config. The Supabase URL and keys come from the
  environment; `src/lib/supabase/client.ts` and `server.ts` throw at load when they are unset. No
  `localhost:<port>` literal either: Playwright takes its base URL from `E2E_PORT`.
- **RLS on every table.** Each table starts with RLS enabled and `revoke all … from anon,
  authenticated`, then grants exactly what ARCHITECTURE.md section 4 lists, with an access test in
  `tests/access/` for each.
- **Design tokens live in `src/app/globals.css`.** Every colour, radius and font comes from its
  CSS variables; components come from shadcn/ui. Light theme only (OQ-41); pages work from 360px
  wide (OQ-40).
- **Server-only secrets are never `NEXT_PUBLIC_`**, and are read only in modules that start with
  `import 'server-only'`. Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  reach the browser.
- **The extraction pipeline stays in Edge Functions** (`submit-document`, `process-queue`,
  `approve-document`, `purge-files`), next to the queue and the data. Next.js route handlers are
  short and never call Claude.
- **Migrations only move forward**, additive and backward-compatible; never edit one that is
  merged.
