import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleStripeWebhook, type WebhookStripe } from '../../src/lib/billing/webhook'
import { withDb } from './local-db'
import { adminClient, personalWorkspaceId, signUp } from './users'

// POST /api/stripe/webhook (ARCHITECTURE.md section 6.2, PRD US-11.1, Lead rulings 2, 3 and 4 on
// #50), with the real database and real signature checks. The events are fixtures signed with
// stripe.webhooks.generateTestHeaderString; the only fake is the Stripe client's one network call
// (ruling 7).

const SECRET = 'whsec_local_test_only'
const PERIOD_END = 1_900_000_000
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString()

type Row = {
  plan: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan_period_end: Date | null
  plan_cancel_at_period_end: boolean
}

async function newWorkspace(): Promise<string> {
  return personalWorkspaceId(await signUp())
}

async function workspace(id: string): Promise<Row> {
  const { rows } = await withDb((db) =>
    db.query<Row>(
      'select plan, stripe_customer_id, stripe_subscription_id, plan_period_end, plan_cancel_at_period_end from public.workspaces where id = $1',
      [id],
    ),
  )
  return rows[0]
}

async function setWorkspace(id: string, values: Partial<Record<keyof Row, unknown>>) {
  const { error } = await adminClient().from('workspaces').update(values).eq('id', id)
  expect(error).toBeNull()
}

async function eventRow(id: string) {
  const { rows } = await withDb((db) =>
    db.query<{ type: string; processed_at: Date | null }>('select type, processed_at from public.stripe_events where id = $1', [id]),
  )
  return rows[0]
}

function eventId() {
  return `evt_${randomUUID()}`
}

function event(type: string, object: unknown, id = eventId()) {
  return { id, object: 'event', type, data: { object } }
}

/** A subscription as Stripe's API sends it: the period end is on its item (ruling 2). */
function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: `sub_${randomUUID()}`,
    object: 'subscription',
    customer: `cus_${randomUUID()}`,
    status: 'active',
    cancel_at_period_end: false,
    metadata: {},
    items: { object: 'list', data: [{ id: 'si_1', current_period_end: PERIOD_END }] },
    ...overrides,
  }
}

function checkoutSession(ws: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: `cs_test_${randomUUID()}`,
    object: 'checkout.session',
    mode: 'subscription',
    customer: `cus_${randomUUID()}`,
    subscription: `sub_${randomUUID()}`,
    metadata: ws ? { workspace_id: ws } : {},
    ...overrides,
  }
}

function fakeStripe(retrieve: (id: string) => Promise<unknown> = async (id) => subscription({ id })) {
  const spy = vi.fn(retrieve)
  const stripe = { subscriptions: { retrieve: spy } } as unknown as WebhookStripe
  return { stripe, retrieve: spy }
}

function signed(body: unknown, secret = SECRET) {
  const payload = JSON.stringify(body)
  return { payload, signature: Stripe.webhooks.generateTestHeaderString({ payload, secret }) }
}

/** Posts a signed fixture to the handler, as the route does. */
async function deliver(body: unknown, stripe: WebhookStripe = fakeStripe().stripe) {
  const { payload, signature } = signed(body)
  return handleStripeWebhook(payload, signature, { admin: adminClient, stripe: () => stripe, secret: () => SECRET })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the signature', () => {
  const unchanged = {
    plan: 'free',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan_period_end: null,
    plan_cancel_at_period_end: false,
  }

  it.each([
    ['missing', () => null],
    ['from another secret', (body: unknown) => signed(body, 'whsec_another').signature],
    ['not a signature', () => 'nonsense'],
  ])('answers 400 and changes nothing when it is %s', async (_name, signature) => {
    const ws = await newWorkspace()
    const body = event('customer.subscription.updated', subscription({ metadata: { workspace_id: ws } }))
    const result = await handleStripeWebhook(JSON.stringify(body), signature(body), {
      admin: adminClient,
      stripe: () => fakeStripe().stripe,
      secret: () => SECRET,
    })
    expect(result.status).toBe(400)
    expect(await workspace(ws)).toEqual(unchanged)
    expect(await eventRow(body.id)).toBeUndefined()
  })

  it('answers 400 and changes nothing when the body was changed after signing', async () => {
    const ws = await newWorkspace()
    const { signature } = signed(event('customer.subscription.updated', subscription({ metadata: { workspace_id: ws } })))
    const tampered = event('customer.subscription.updated', subscription({ metadata: { workspace_id: ws } }))
    const result = await handleStripeWebhook(JSON.stringify(tampered), signature, {
      admin: adminClient,
      stripe: () => fakeStripe().stripe,
      secret: () => SECRET,
    })
    expect(result.status).toBe(400)
    expect(await workspace(ws)).toEqual(unchanged)
  })

  it('answers 500, changing nothing, when the signing secret is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = await newWorkspace()
    const { payload, signature } = signed(event('customer.subscription.updated', subscription({ metadata: { workspace_id: ws } })))
    const result = await handleStripeWebhook(payload, signature, {
      admin: adminClient,
      stripe: () => fakeStripe().stripe,
      secret: () => {
        throw new Error('STRIPE_WEBHOOK_SECRET is not set.')
      },
    })
    expect(result.status).toBe(500)
    expect(await workspace(ws)).toEqual(unchanged)
  })
})

describe('checkout.session.completed', () => {
  it('makes the workspace Pro with its customer, subscription and period end, read from the session’s metadata', async () => {
    const ws = await newWorkspace()
    const session = checkoutSession(ws)
    const { stripe, retrieve } = fakeStripe()
    const body = event('checkout.session.completed', session)

    expect((await deliver(body, stripe)).status).toBe(200)

    expect(await workspace(ws)).toEqual({
      plan: 'pro',
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      plan_period_end: new Date(PERIOD_END_ISO),
      plan_cancel_at_period_end: false,
    })
    expect(retrieve).toHaveBeenCalledWith(session.subscription)
    expect((await eventRow(body.id)).processed_at).not.toBeNull()
  })

  it('answers 200, changes nothing and logs an error when its metadata names no workspace or an unknown one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = await newWorkspace()
    const before = await workspace(ws)
    for (const named of [null, randomUUID(), 'not-a-uuid']) {
      error.mockClear()
      const { stripe, retrieve } = fakeStripe()
      const body = event('checkout.session.completed', checkoutSession(named))
      expect((await deliver(body, stripe)).status).toBe(200)
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0].join(' '))).toContain(body.id)
      expect(retrieve).not.toHaveBeenCalled()
    }
    expect(await workspace(ws)).toEqual(before)
  })
})

describe('customer.subscription.updated', () => {
  it('with cancel_at_period_end true keeps Pro and sets the period end', async () => {
    const ws = await newWorkspace()
    await setWorkspace(ws, { plan: 'pro', stripe_customer_id: `cus_${randomUUID()}`, plan_period_end: '2030-01-01T00:00:00Z' })
    const sub = subscription({ cancel_at_period_end: true, metadata: { workspace_id: ws } })

    expect((await deliver(event('customer.subscription.updated', sub))).status).toBe(200)

    expect(await workspace(ws)).toEqual({
      plan: 'pro',
      stripe_customer_id: sub.customer,
      stripe_subscription_id: sub.id,
      plan_period_end: new Date(PERIOD_END_ISO),
      plan_cancel_at_period_end: true,
    })
  })

  it('clears the set-to-end flag when the subscription is renewed again', async () => {
    const ws = await newWorkspace()
    await setWorkspace(ws, { plan: 'pro', plan_cancel_at_period_end: true })
    await deliver(event('customer.subscription.updated', subscription({ metadata: { workspace_id: ws } })))
    expect((await workspace(ws)).plan_cancel_at_period_end).toBe(false)
  })

  it.each([
    ['active', 'pro'],
    ['past_due', 'pro'],
    ['trialing', 'free'],
    ['incomplete', 'free'],
    ['incomplete_expired', 'free'],
    ['unpaid', 'free'],
    ['canceled', 'free'],
    ['paused', 'free'],
  ])('with status %s means %s (ruling 4)', async (status, plan) => {
    const ws = await newWorkspace()
    await setWorkspace(ws, { plan: plan === 'pro' ? 'free' : 'pro' })
    await deliver(event('customer.subscription.updated', subscription({ status, metadata: { workspace_id: ws } })))
    expect((await workspace(ws)).plan).toBe(plan)
  })

  it('falls back to the workspace’s customer when the subscription’s metadata names none (ruling 2)', async () => {
    const ws = await newWorkspace()
    const customer = `cus_${randomUUID()}`
    await setWorkspace(ws, { stripe_customer_id: customer })
    await deliver(event('customer.subscription.updated', subscription({ customer })))
    expect((await workspace(ws)).plan).toBe('pro')
  })

  it('falls back to the workspace’s customer when the subscription’s metadata names an unknown workspace', async () => {
    const ws = await newWorkspace()
    const customer = `cus_${randomUUID()}`
    await setWorkspace(ws, { stripe_customer_id: customer })
    await deliver(event('customer.subscription.updated', subscription({ customer, metadata: { workspace_id: randomUUID() } })))
    expect((await workspace(ws)).plan).toBe('pro')
  })

  it('answers 200, changes nothing and logs an error when no workspace matches', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = await newWorkspace()
    const before = await workspace(ws)
    const body = event('customer.subscription.updated', subscription())
    expect((await deliver(body)).status).toBe(200)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0].join(' '))).toContain(body.id)
    expect(await workspace(ws)).toEqual(before)
    expect((await eventRow(body.id)).processed_at).not.toBeNull()
  })
})

describe('customer.subscription.deleted', () => {
  it('makes it Free, clears the subscription and period end, and keeps the customer (ruling 4)', async () => {
    const ws = await newWorkspace()
    const customer = `cus_${randomUUID()}`
    await setWorkspace(ws, {
      plan: 'pro',
      stripe_customer_id: customer,
      stripe_subscription_id: 'sub_old',
      plan_period_end: PERIOD_END_ISO,
      plan_cancel_at_period_end: true,
    })

    const result = await deliver(event('customer.subscription.deleted', subscription({ customer, status: 'canceled', metadata: { workspace_id: ws } })))

    expect(result.status).toBe(200)
    expect(await workspace(ws)).toEqual({
      plan: 'free',
      stripe_customer_id: customer,
      stripe_subscription_id: null,
      plan_period_end: null,
      plan_cancel_at_period_end: false,
    })
  })

  it('always means Free, whatever status the subscription carries', async () => {
    const ws = await newWorkspace()
    await setWorkspace(ws, { plan: 'pro' })
    await deliver(event('customer.subscription.deleted', subscription({ status: 'active', metadata: { workspace_id: ws } })))
    expect((await workspace(ws)).plan).toBe('free')
  })

  it('falls back to the workspace’s customer too', async () => {
    const ws = await newWorkspace()
    const customer = `cus_${randomUUID()}`
    await setWorkspace(ws, { plan: 'pro', stripe_customer_id: customer })
    await deliver(event('customer.subscription.deleted', subscription({ customer, status: 'canceled' })))
    expect((await workspace(ws)).plan).toBe('free')
  })
})

describe('idempotency (ruling 3)', () => {
  it('changes nothing the second time a processed event arrives', async () => {
    const ws = await newWorkspace()
    const { stripe, retrieve } = fakeStripe()
    const body = event('checkout.session.completed', checkoutSession(ws))

    expect((await deliver(body, stripe)).status).toBe(200)
    const firstProcessed = (await eventRow(body.id)).processed_at
    // Something moved the workspace on since; the duplicate must not undo it.
    await setWorkspace(ws, { plan: 'free' })

    expect((await deliver(body, stripe)).status).toBe(200)

    expect((await workspace(ws)).plan).toBe('free')
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect((await eventRow(body.id)).processed_at).toEqual(firstProcessed)
  })

  it('answers 500 when processing fails, leaves processed_at null, and processes the event when Stripe sends it again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = await newWorkspace()
    const body = event('checkout.session.completed', checkoutSession(ws))
    const failing = fakeStripe(async () => {
      throw new Error('Stripe is having a moment')
    })

    expect((await deliver(body, failing.stripe)).status).toBe(500)
    expect((await workspace(ws)).plan).toBe('free')
    expect(await eventRow(body.id)).toMatchObject({ type: 'checkout.session.completed', processed_at: null })

    expect((await deliver(body)).status).toBe(200)
    expect((await workspace(ws)).plan).toBe('pro')
    expect((await eventRow(body.id)).processed_at).not.toBeNull()
  })
})

describe('any other event type', () => {
  it('is acknowledged with 200 without changing a workspace', async () => {
    const ws = await newWorkspace()
    const before = await workspace(ws)
    const { stripe, retrieve } = fakeStripe()
    const sub = subscription({ metadata: { workspace_id: ws } })
    for (const type of ['customer.subscription.created', 'invoice.paid', 'customer.created']) {
      expect((await deliver(event(type, sub), stripe)).status).toBe(200)
    }
    expect(await workspace(ws)).toEqual(before)
    expect(retrieve).not.toHaveBeenCalled()
  })
})
