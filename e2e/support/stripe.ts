import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import Stripe from 'stripe'
import { E2E_STRIPE_WEBHOOK_SECRET } from './stripe-secret'
import { sql } from './auth'

// Stripe fixtures for the billing specs (Lead ruling 7 on #50): nothing here reaches Stripe. Events
// are signed locally and posted to the webhook of the running app; the two /api/billing/* calls a
// browser makes are intercepted by each spec. The dev server has no STRIPE_SECRET_KEY at all.

export interface SubscriptionFixture {
  ws: string
  status?: string
  cancelAtPeriodEnd?: boolean
  /** Unix seconds. */
  periodEnd?: number
}

function subscriptionObject({ ws, status = 'active', cancelAtPeriodEnd = false, periodEnd = 1_900_000_000 }: SubscriptionFixture) {
  return {
    id: `sub_${randomUUID()}`,
    object: 'subscription',
    customer: `cus_${randomUUID()}`,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    metadata: { workspace_id: ws },
    items: { object: 'list', data: [{ id: 'si_1', current_period_end: periodEnd }] },
  }
}

/** Posts a signed fixture event to the running app's webhook, and returns its answer. */
export async function postEvent(request: APIRequestContext, type: string, object: unknown, secret = E2E_STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', type, data: { object } })
  return request.post('/api/stripe/webhook', {
    data: payload,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }),
    },
  })
}

export function postSubscriptionUpdated(request: APIRequestContext, fixture: SubscriptionFixture) {
  return postEvent(request, 'customer.subscription.updated', subscriptionObject(fixture))
}

export function postSubscriptionDeleted(request: APIRequestContext, fixture: SubscriptionFixture) {
  return postEvent(request, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled', ...fixture }))
}

export function subscriptionFixture(fixture: SubscriptionFixture) {
  return subscriptionObject(fixture)
}

/** Sets a workspace's plan columns directly in the database, as only the webhook can in the app. */
export async function setPlan(
  ws: string,
  plan: { plan: 'free' | 'pro'; customer?: string | null; subscription?: string | null; periodEnd?: string | null; cancelAtPeriodEnd?: boolean },
) {
  await sql(
    `update public.workspaces set plan = $2, stripe_customer_id = $3, stripe_subscription_id = $4, plan_period_end = $5,
       plan_cancel_at_period_end = $6 where id = $1`,
    [ws, plan.plan, plan.customer ?? null, plan.subscription ?? null, plan.periodEnd ?? null, plan.cancelAtPeriodEnd ?? false],
  )
}

export async function setPagesUsed(ws: string, pages: number) {
  await sql(
    `insert into public.page_usage (workspace_id, period_start, pages_used)
     values ($1, date_trunc('month', now() at time zone 'utc')::date, $2)
     on conflict (workspace_id, period_start) do update set pages_used = excluded.pages_used`,
    [ws, pages],
  )
}
