import { randomUUID } from 'node:crypto'
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createCheckout, createPortal, type CheckoutStripe, type PortalStripe } from '../../src/lib/billing/sessions'
import { withDb } from './local-db'
import { addMember, anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

// POST /api/billing/checkout and /api/billing/portal (ARCHITECTURE.md section 6.2, PRD US-11.1,
// OQ-20, OQ-24, OQ-37, Lead rulings 2 and 6 on #50), with real users and RLS. The Stripe client is
// a fake that records what it is asked for (ruling 7).

const SITE = 'https://site.test'
const settings = () => ({
  priceId: 'price_test_pro',
  successUrl: (workspaceId: string) => `${SITE}/billing?checkout=success&workspace=${workspaceId}`,
  cancelUrl: `${SITE}/billing`,
})

async function setWorkspace(ws: string, plan: 'free' | 'pro', customer: string | null) {
  await withDb((db) => db.query('update public.workspaces set plan = $2, stripe_customer_id = $3 where id = $1', [ws, plan, customer]))
}

function fakeCheckout(url: string | null = 'https://checkout.stripe.test/session') {
  const create = vi.fn(async (params: unknown) => {
    void params
    return { url }
  })
  return { stripe: { checkout: { sessions: { create } } } as unknown as CheckoutStripe, create }
}

function fakePortal(url = 'https://billing.stripe.test/session') {
  const create = vi.fn(async (params: unknown) => {
    void params
    return { url }
  })
  return { stripe: { billingPortal: { sessions: { create } } } as unknown as PortalStripe, create }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCheckout', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
  })

  it('creates a subscription-mode session for the Pro price, with no trial and the workspace in both metadata, and returns its URL', async () => {
    await setWorkspace(ws, 'free', null)
    const { stripe, create } = fakeCheckout()

    const result = await createCheckout(ws, { asCaller: owner.client, stripe: () => stripe, settings })

    expect(result).toEqual({ status: 200, url: 'https://checkout.stripe.test/session' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toEqual({
      mode: 'subscription',
      line_items: [{ price: 'price_test_pro', quantity: 1 }],
      metadata: { workspace_id: ws },
      subscription_data: { metadata: { workspace_id: ws } },
      success_url: `${SITE}/billing?checkout=success&workspace=${ws}`,
      cancel_url: `${SITE}/billing`,
    })
  })

  it('reuses the workspace’s Stripe customer when it has one (ruling 2)', async () => {
    const customer = `cus_${randomUUID()}`
    await setWorkspace(ws, 'free', customer)
    const { stripe, create } = fakeCheckout()
    await createCheckout(ws, { asCaller: owner.client, stripe: () => stripe, settings })
    expect(create.mock.calls[0][0]).toMatchObject({ customer })
    await setWorkspace(ws, 'free', null)
  })

  it('answers 401 with no session, before touching Stripe', async () => {
    const stripeFactory = vi.fn()
    const result = await createCheckout(ws, { asCaller: anonClient(), stripe: stripeFactory, settings })
    expect(result.status).toBe(401)
    expect(stripeFactory).not.toHaveBeenCalled()
  })

  it.each(['member', 'stranger'])('answers 403 to a %s', async (who) => {
    await setWorkspace(ws, 'free', null)
    const stripeFactory = vi.fn()
    const asCaller = who === 'member' ? member.client : stranger.client
    const result = await createCheckout(ws, { asCaller, stripe: stripeFactory, settings })
    expect(result.status).toBe(403)
    expect(stripeFactory).not.toHaveBeenCalled()
  })

  it('answers 403 to a workspace id that is not one', async () => {
    const stripeFactory = vi.fn()
    expect((await createCheckout('not-a-uuid', { asCaller: owner.client, stripe: stripeFactory, settings })).status).toBe(403)
    expect((await createCheckout(undefined, { asCaller: owner.client, stripe: stripeFactory, settings })).status).toBe(403)
    expect(stripeFactory).not.toHaveBeenCalled()
  })

  it('answers 409 to a workspace already on Pro', async () => {
    await setWorkspace(ws, 'pro', `cus_${randomUUID()}`)
    const stripeFactory = vi.fn()
    const result = await createCheckout(ws, { asCaller: owner.client, stripe: stripeFactory, settings })
    expect(result.status).toBe(409)
    expect(stripeFactory).not.toHaveBeenCalled()
    await setWorkspace(ws, 'free', null)
  })

  it('answers 500, with a message and nothing changed, when Stripe or a setting fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = {
      checkout: {
        sessions: {
          create: async () => {
            throw new Error('Stripe is having a moment')
          },
        },
      },
    } as unknown as CheckoutStripe
    const stripeDown = await createCheckout(ws, { asCaller: owner.client, stripe: () => failing, settings })
    expect(stripeDown.status).toBe(500)
    expect(stripeDown.error).toBeTruthy()

    const unset = await createCheckout(ws, {
      asCaller: owner.client,
      stripe: () => {
        throw new Error('STRIPE_SECRET_KEY is not set.')
      },
      settings,
    })
    expect(unset.status).toBe(500)
    expect(unset.error).not.toContain('STRIPE_SECRET_KEY')
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('answers 500 when Stripe returns a session with no URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { stripe } = fakeCheckout(null)
    expect((await createCheckout(ws, { asCaller: owner.client, stripe: () => stripe, settings })).status).toBe(500)
  })
})

describe('createPortal', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string
  const returnUrl = () => `${SITE}/billing`

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
  })

  it('creates a portal session for the workspace’s customer, returning to the billing page, and returns its URL', async () => {
    const customer = `cus_${randomUUID()}`
    await setWorkspace(ws, 'pro', customer)
    const { stripe, create } = fakePortal()

    const result = await createPortal(ws, { asCaller: owner.client, stripe: () => stripe, returnUrl })

    expect(result).toEqual({ status: 200, url: 'https://billing.stripe.test/session' })
    expect(create).toHaveBeenCalledWith({ customer, return_url: `${SITE}/billing` })
  })

  it('answers 401 with no session', async () => {
    const stripeFactory = vi.fn()
    expect((await createPortal(ws, { asCaller: anonClient(), stripe: stripeFactory, returnUrl })).status).toBe(401)
    expect(stripeFactory).not.toHaveBeenCalled()
  })

  it.each(['member', 'stranger'])('answers 403 to a %s', async (who) => {
    await setWorkspace(ws, 'pro', `cus_${randomUUID()}`)
    const stripeFactory = vi.fn()
    const asCaller = who === 'member' ? member.client : stranger.client
    expect((await createPortal(ws, { asCaller, stripe: stripeFactory, returnUrl })).status).toBe(403)
    expect(stripeFactory).not.toHaveBeenCalled()
  })

  it('answers 409 to a workspace with no Stripe customer', async () => {
    await setWorkspace(ws, 'free', null)
    const stripeFactory = vi.fn()
    expect((await createPortal(ws, { asCaller: owner.client, stripe: stripeFactory, returnUrl })).status).toBe(409)
    expect(stripeFactory).not.toHaveBeenCalled()
  })

  it('answers 500, with a message, when Stripe fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await setWorkspace(ws, 'pro', `cus_${randomUUID()}`)
    const failing = {
      billingPortal: {
        sessions: {
          create: async () => {
            throw new Error('Stripe is having a moment')
          },
        },
      },
    } as unknown as PortalStripe
    const result = await createPortal(ws, { asCaller: owner.client, stripe: () => failing, returnUrl })
    expect(result.status).toBe(500)
    expect(result.error).toBeTruthy()
  })
})
