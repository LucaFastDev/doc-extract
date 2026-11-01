import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// The Stripe webhook (ARCHITECTURE.md section 6.2, PRD US-11.1, Lead rulings 2, 3 and 4 on #50),
// behind POST /api/stripe/webhook. tests/access/stripe-webhook.test.ts runs this with the real
// database and real signature checks.

export type WebhookStripe = Pick<Stripe, 'subscriptions'>

export interface WebhookDeps {
  /** The service-role client: the plan and Stripe columns accept no other writer. */
  admin: () => SupabaseClient
  /** checkout.session.completed and customer.subscription.updated retrieve the current subscription. */
  stripe: () => WebhookStripe
  secret: () => string
}

export interface WebhookResult {
  status: 200 | 400 | 500
  error?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Admin = SupabaseClient

function idOf(value: string | { id: string } | null): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

/** This Stripe API version keeps the period end on the subscription's item (ruling 2). */
function periodEnd(subscription: Stripe.Subscription): string | null {
  const seconds = subscription.items.data[0]?.current_period_end
  return seconds ? new Date(seconds * 1000).toISOString() : null
}

async function workspaceById(admin: Admin, id: string | undefined): Promise<string | null> {
  if (!id || !UUID.test(id)) return null
  const { data, error } = await admin.from('workspaces').select('id').eq('id', id).maybeSingle<{ id: string }>()
  if (error) throw error
  return data?.id ?? null
}

/** The workspace in the subscription's metadata, or else the one with its customer (ruling 2). */
async function workspaceOfSubscription(admin: Admin, subscription: Stripe.Subscription): Promise<string | null> {
  const named = await workspaceById(admin, subscription.metadata?.workspace_id)
  if (named) return named
  const customer = idOf(subscription.customer)
  if (!customer) return null
  const { data, error } = await admin
    .from('workspaces')
    .select('id')
    .eq('stripe_customer_id', customer)
    .maybeSingle<{ id: string }>()
  if (error) throw error
  return data?.id ?? null
}

async function setWorkspace(admin: Admin, id: string, values: Record<string, unknown>) {
  const { error } = await admin.from('workspaces').update(values).eq('id', id)
  if (error) throw error
}

/** The subscription the workspace holds now, or null when it holds none. */
async function heldSubscription(admin: Admin, id: string): Promise<string | null> {
  const { data, error } = await admin
    .from('workspaces')
    .select('stripe_subscription_id')
    .eq('id', id)
    .single<{ stripe_subscription_id: string | null }>()
  if (error) throw error
  return data.stripe_subscription_id
}

/** Whether the subscription keeps the workspace on Pro (ruling 4 on #50): only these two statuses do. */
function keepsPro(subscription: Stripe.Subscription): boolean {
  return subscription.status === 'active' || subscription.status === 'past_due'
}

function logUnknownWorkspace(event: Stripe.Event) {
  console.error('Stripe event', event.id, 'of type', event.type, 'names no known workspace; nothing was changed.')
}

/** An event about a subscription the workspace has moved on from: acknowledged, nothing written. */
function logIgnored(event: Stripe.Event, reason: string) {
  console.warn('Stripe event', event.id, 'of type', event.type, 'was ignored:', reason)
}

async function onCheckoutCompleted(event: Stripe.Event, session: Stripe.Checkout.Session, deps: WebhookDeps, admin: Admin) {
  const workspace = await workspaceById(admin, session.metadata?.workspace_id ?? undefined)
  if (!workspace) return logUnknownWorkspace(event)
  const subscriptionId = idOf(session.subscription)
  if (!subscriptionId) {
    console.error('Stripe event', event.id, 'is a completed Checkout with no subscription; nothing was changed.')
    return
  }
  // A Checkout session carries neither the period end nor the subscription's status now.
  const subscription = await deps.stripe().subscriptions.retrieve(subscriptionId)
  if (!keepsPro(subscription)) {
    return logIgnored(event, `its subscription ${subscriptionId} is ${subscription.status}, not active or past_due.`)
  }
  await setWorkspace(admin, workspace, {
    plan: 'pro',
    stripe_customer_id: idOf(session.customer),
    stripe_subscription_id: subscriptionId,
    plan_period_end: periodEnd(subscription),
    plan_cancel_at_period_end: subscription.cancel_at_period_end,
  })
}

/**
 * Stripe does not keep events in order and retries them late, so the event's copy of the
 * subscription may be stale: the current one is retrieved and used for everything (issue 73). A
 * failed retrieve throws, so the event answers 500 and Stripe sends it again.
 */
async function onSubscriptionUpdated(event: Stripe.Event, eventCopy: Stripe.Subscription, deps: WebhookDeps, admin: Admin) {
  const subscription = await deps.stripe().subscriptions.retrieve(eventCopy.id)
  const workspace = await workspaceOfSubscription(admin, subscription)
  if (!workspace) return logUnknownWorkspace(event)
  const keeps = keepsPro(subscription)
  if (!keeps) {
    // A subscription that is not paying only ends the plan if it is the one the workspace holds.
    const held = await heldSubscription(admin, workspace)
    if (held !== subscription.id) {
      return logIgnored(event, `its subscription ${subscription.id} is ${subscription.status} and the workspace holds ${held ?? 'none'}.`)
    }
  }
  await setWorkspace(admin, workspace, {
    plan: keeps ? 'pro' : 'free',
    stripe_customer_id: idOf(subscription.customer),
    stripe_subscription_id: subscription.id,
    plan_period_end: periodEnd(subscription),
    plan_cancel_at_period_end: subscription.cancel_at_period_end,
  })
}

async function onSubscriptionDeleted(event: Stripe.Event, subscription: Stripe.Subscription, admin: Admin) {
  const workspace = await workspaceOfSubscription(admin, subscription)
  if (!workspace) return logUnknownWorkspace(event)
  // A deletion of an older subscription must not clear the one the workspace holds now.
  const held = await heldSubscription(admin, workspace)
  if (held !== null && held !== subscription.id) {
    return logIgnored(event, `its subscription ${subscription.id} is not the ${held} the workspace holds.`)
  }
  // Ruling 4: the customer stays, so a later upgrade reuses it.
  await setWorkspace(admin, workspace, {
    plan: 'free',
    stripe_subscription_id: null,
    plan_period_end: null,
    plan_cancel_at_period_end: false,
  })
}

async function processEvent(event: Stripe.Event, deps: WebhookDeps, admin: Admin) {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event, event.data.object, deps, admin)
    case 'customer.subscription.updated':
      return onSubscriptionUpdated(event, event.data.object, deps, admin)
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event, event.data.object, admin)
    default:
      // Any other type is acknowledged and changes no workspace.
      return
  }
}

/**
 * Verifies the signature over the raw body, then processes the event once. Its row in stripe_events
 * is inserted on first sight and processed_at set only after processing, so an event counts as a
 * duplicate only once it has really been processed, and a failure answers 500 for Stripe to retry
 * (ruling 3). An event naming no known workspace is logged and answered 200: a retry would not help.
 */
export async function handleStripeWebhook(rawBody: string, signature: string | null, deps: WebhookDeps): Promise<WebhookResult> {
  if (!signature) return { status: 400, error: 'Missing signature.' }

  let secret: string
  try {
    secret = deps.secret()
  } catch (error) {
    console.error('The Stripe webhook cannot verify events.', error)
    return { status: 500, error: 'The webhook is not configured.' }
  }

  let event: Stripe.Event
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret)
  } catch {
    return { status: 400, error: 'Invalid signature.' }
  }

  try {
    const admin = deps.admin()
    const inserted = await admin
      .from('stripe_events')
      .upsert({ id: event.id, type: event.type }, { onConflict: 'id', ignoreDuplicates: true })
    if (inserted.error) throw inserted.error

    const seen = await admin.from('stripe_events').select('processed_at').eq('id', event.id).single<{ processed_at: string | null }>()
    if (seen.error) throw seen.error
    if (seen.data.processed_at) return { status: 200 }

    await processEvent(event, deps, admin)

    const processed = await admin.from('stripe_events').update({ processed_at: new Date().toISOString() }).eq('id', event.id)
    if (processed.error) throw processed.error
    return { status: 200 }
  } catch (error) {
    console.error('Stripe event', event.id, 'could not be processed.', error)
    return { status: 500, error: 'The event could not be processed.' }
  }
}
