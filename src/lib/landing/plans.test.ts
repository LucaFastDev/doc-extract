import { describe, expect, it } from 'vitest'
import { formatPrice, loadPlans, type PlanLimitsClient } from './plans'

// The landing page's plans (issue #45 criterion 3): what get_plan_limits() returns, as the page
// shows it. The local stack's own answer is checked by e2e/landing.spec.ts.

function client(result: { data: unknown; error: { message: string } | null }): PlanLimitsClient {
  return { rpc: async (fn: 'get_plan_limits') => (fn === 'get_plan_limits' ? result : { data: null, error: { message: 'unknown' } }) }
}

describe('formatPrice', () => {
  it('writes a whole-dollar price as $19 and a price with cents with two decimals', () => {
    expect(formatPrice(19)).toBe('$19')
    expect(formatPrice(0)).toBe('$0')
    expect(formatPrice('19.00')).toBe('$19')
    expect(formatPrice(9.5)).toBe('$9.50')
  })
})

describe('loadPlans', () => {
  it('gives the pages and the price of Free and Pro', async () => {
    const plans = await loadPlans(
      client({
        data: [
          { plan: 'pro', pages_per_period: 500, monthly_price_usd: 19 },
          { plan: 'free', pages_per_period: 20, monthly_price_usd: 0 },
        ],
        error: null,
      }),
    )
    expect(plans).toEqual({ free: { pages: 20, price: '$0' }, pro: { pages: 500, price: '$19' } })
  })

  it('fails rather than show wrong plans when the call fails or a plan is missing', async () => {
    await expect(loadPlans(client({ data: null, error: { message: 'down' } }))).rejects.toThrow('down')
    await expect(loadPlans(client({ data: [{ plan: 'free', pages_per_period: 20, monthly_price_usd: 0 }], error: null }))).rejects.toThrow('pro')
  })
})
