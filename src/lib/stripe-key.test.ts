import { describe, expect, it } from 'vitest'
import { stripeKeyProblem } from './stripe-key'

// The one check behind both refusals of a live key (PRD US-11.1 AC-4, Lead ruling 1 on #50).
describe('stripeKeyProblem', () => {
  it.each(['sk_test_abc', 'sk_test_'])('accepts the test key %s', (key) => {
    expect(stripeKeyProblem(key)).toBeNull()
  })

  it.each(['sk_live_abc', 'rk_live_abc', 'rk_test_abc', 'pk_test_abc', 'whsec_abc', 'SK_TEST_abc', ' sk_test_abc', 'abc'])(
    'refuses %s as not a test key',
    (key) => {
      expect(stripeKeyProblem(key)).toBe('not_test')
    },
  )

  it.each([[undefined], ['']])('reports %j as unset', (key) => {
    expect(stripeKeyProblem(key)).toBe('unset')
  })
})
