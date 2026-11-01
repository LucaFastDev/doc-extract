-- Milestone 9 (ARCHITECTURE.md sections 4.2 and 6.2, PRD F11): billing in Stripe test mode.

-- Webhook idempotency (Lead ruling 3 on #50): a row is inserted the first time an event is seen, and
-- processed_at is set once it has been processed. An event counts as a duplicate only when
-- processed_at is set, so one whose processing failed is processed when Stripe sends it again.
create table public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.stripe_events enable row level security;
-- No policy and no client grants: only the webhook route handler's service-role client uses it.
revoke all on table public.stripe_events from anon, authenticated;

-- Whether the subscription is set to end at plan_period_end rather than renew, so the billing page
-- can say when it ends without calling Stripe. Written only by the webhook route handler: clients
-- may update only workspaces.name (column grant, section 4.2).
alter table public.workspaces add column plan_cancel_at_period_end boolean not null default false;
