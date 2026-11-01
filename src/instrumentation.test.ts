import { afterEach, describe, expect, it, vi } from 'vitest'
import { register } from './instrumentation'

// Server start (PRD US-11.1 AC-4, Lead ruling 1 on #50): a set key that is not a test key stops the
// server; an unset one does not, because the demo and the landing page run without Stripe.
describe('register', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['sk_live_abc', 'rk_live_abc', 'rk_test_abc'])('refuses to start with %s', (key) => {
    vi.stubEnv('STRIPE_SECRET_KEY', key)
    expect(() => register()).toThrow(/STRIPE_SECRET_KEY/)
  })

  it('does not repeat the key in its message', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_abc')
    expect(() => register()).not.toThrow(/sk_live_abc/)
  })

  it('starts with a test key', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc')
    expect(() => register()).not.toThrow()
  })

  it('starts with the key unset', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(() => register()).not.toThrow()
    vi.stubEnv('STRIPE_SECRET_KEY', undefined as unknown as string)
    expect(() => register()).not.toThrow()
  })
})
