import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCheckoutReturn, type CheckoutStripe } from './sessions'

// checkCheckoutReturn with a fake Stripe and a fake caller; tests/access/billing-routes.test.ts runs
// its route with real users.

const WS = '11111111-2222-3333-4444-555555555555'
const OTHER_WS = '66666666-7777-8888-9999-000000000000'
const SESSION_ID = 'cs_test_1'

function caller({ signedIn = true, owner = true } = {}) {
  return {
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: 'user-1' } : null } }) },
    rpc: async () => ({ data: owner, error: null }),
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { id: WS, plan: 'free', stripe_customer_id: null }, error: null }) }),
      }),
    }),
  } as unknown as SupabaseClient
}

function completed(overrides: Record<string, unknown> = {}) {
  return { status: 'complete', metadata: { workspace_id: WS }, subscription: { status: 'active' }, ...overrides }
}

function fakeStripe(session: unknown) {
  const retrieve = vi.fn(async (id: string, params: unknown) => {
    void id
    void params
    return session
  })
  return { stripe: () => ({ checkout: { sessions: { retrieve } } }) as unknown as CheckoutStripe, retrieve }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkCheckoutReturn', () => {
  it('asks Stripe for the session with its subscription expanded', async () => {
    const { stripe, retrieve } = fakeStripe(completed())
    await checkCheckoutReturn(WS, SESSION_ID, { asCaller: caller(), stripe })
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledWith(SESSION_ID, { expand: ['subscription'] })
  })

  it.each(['active', 'trialing'])('is paid for a completed session of this workspace with its subscription %s', async (status) => {
    const { stripe } = fakeStripe(completed({ subscription: { status } }))
    expect(await checkCheckoutReturn(WS, SESSION_ID, { asCaller: caller(), stripe })).toEqual({ status: 200, paid: true })
  })

  it.each([
    ['the subscription is canceled', { subscription: { status: 'canceled' } }],
    ['the subscription is past due', { subscription: { status: 'past_due' } }],
    ['the subscription was not expanded', { subscription: 'sub_1' }],
    ['there is no subscription', { subscription: null }],
    ['the session is open', { status: 'open' }],
    ['the session expired', { status: 'expired' }],
    ['the session is another workspace’s', { metadata: { workspace_id: OTHER_WS } }],
    ['the session has no metadata', { metadata: null }],
  ])('is not paid when %s', async (_name, overrides) => {
    const { stripe } = fakeStripe(completed(overrides))
    expect(await checkCheckoutReturn(WS, SESSION_ID, { asCaller: caller(), stripe })).toEqual({ status: 200, paid: false })
  })

  it('answers 500 with its text, and logs, when retrieve throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const retrieve = vi.fn(async () => {
      throw new Error('No such checkout.session')
    })
    const stripe = () => ({ checkout: { sessions: { retrieve } } }) as unknown as CheckoutStripe
    expect(await checkCheckoutReturn(WS, SESSION_ID, { asCaller: caller(), stripe })).toEqual({
      status: 500,
      error: 'The payment could not be checked.',
    })
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('answers 500 with its text when Stripe is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stripe = () => {
      throw new Error('STRIPE_SECRET_KEY is not set.')
    }
    expect(await checkCheckoutReturn(WS, SESSION_ID, { asCaller: caller(), stripe })).toEqual({
      status: 500,
      error: 'The payment could not be checked.',
    })
  })

  it.each([
    ['not a string', 42],
    ['missing', undefined],
    ['not starting with cs_', 'pi_1'],
    ['empty', ''],
    ['over 255 characters', `cs_${'x'.repeat(253)}`],
  ])('is not paid, with no retrieve call, for a session id that is %s', async (_name, sessionId) => {
    const { stripe, retrieve } = fakeStripe(completed())
    expect(await checkCheckoutReturn(WS, sessionId, { asCaller: caller(), stripe })).toEqual({ status: 200, paid: false })
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('asks Stripe about an id of exactly 255 characters', async () => {
    const { stripe, retrieve } = fakeStripe(completed())
    const sessionId = `cs_${'x'.repeat(252)}`
    expect(await checkCheckoutReturn(WS, sessionId, { asCaller: caller(), stripe })).toEqual({ status: 200, paid: true })
    expect(retrieve).toHaveBeenCalledTimes(1)
  })

  it('answers 401 signed out, without touching Stripe', async () => {
    const { stripe, retrieve } = fakeStripe(completed())
    const result = await checkCheckoutReturn(WS, SESSION_ID, { asCaller: caller({ signedIn: false }), stripe })
    expect(result).toEqual({ status: 401, error: 'Sign in to manage billing.' })
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('answers 403 to someone who is not an owner, without touching Stripe', async () => {
    const { stripe, retrieve } = fakeStripe(completed())
    const result = await checkCheckoutReturn(WS, SESSION_ID, { asCaller: caller({ owner: false }), stripe })
    expect(result).toEqual({ status: 403, error: 'Only an owner of this workspace can manage billing.' })
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('answers 403 to a malformed session id from someone who is not an owner, the check of the owner coming first', async () => {
    const { stripe } = fakeStripe(completed())
    const result = await checkCheckoutReturn(WS, 'not_a_session', { asCaller: caller({ owner: false }), stripe })
    expect(result.status).toBe(403)
  })
})
