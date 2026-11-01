import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStripe, STRIPE_API_VERSION, stripePricePro, stripeWebhookSecret } from './stripe'

// The only place that creates a Stripe client (Lead ruling 1 on #50). Nothing here reaches Stripe:
// making a client calls nothing.
describe('getStripe', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['sk_live_abc', 'rk_live_abc', 'rk_test_abc'])('throws on use with %s', (key) => {
    vi.stubEnv('STRIPE_SECRET_KEY', key)
    expect(() => getStripe()).toThrow(/does not start with sk_test_/)
  })

  it('throws on use when the key is unset', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY is not set/)
  })

  it('never repeats the key in its message', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_abc')
    expect(() => getStripe()).not.toThrow(/sk_live_abc/)
  })

  it('makes a client with a test key, on the pinned API version', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc')
    const stripe = getStripe()
    expect(stripe.subscriptions).toBeDefined()
    expect(stripe.getApiField('version')).toBe(STRIPE_API_VERSION)
  })
})

describe('src/lib/stripe.ts', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url))

  it('is the only module under src/ that creates a Stripe client', () => {
    const creators = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => /new Stripe\(/.test(readFileSync(join(SRC, file), 'utf8')))
    expect(creators).toEqual([join('lib', 'stripe.ts')])
  })

  it('is server-only', () => {
    expect(readFileSync(join(SRC, 'lib', 'stripe.ts'), 'utf8').split('\n')[0]).toBe("import 'server-only'")
  })
})

describe('the other Stripe settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws when STRIPE_PRICE_PRO is unset, and returns it when set', () => {
    vi.stubEnv('STRIPE_PRICE_PRO', '')
    expect(() => stripePricePro()).toThrow(/STRIPE_PRICE_PRO is not set/)
    vi.stubEnv('STRIPE_PRICE_PRO', 'price_abc')
    expect(stripePricePro()).toBe('price_abc')
  })

  it('throws when STRIPE_WEBHOOK_SECRET is unset, and returns it when set', () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
    expect(() => stripeWebhookSecret()).toThrow(/STRIPE_WEBHOOK_SECRET is not set/)
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_abc')
    expect(stripeWebhookSecret()).toBe('whsec_abc')
  })
})
