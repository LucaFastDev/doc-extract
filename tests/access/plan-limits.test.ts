import { describe, expect, it } from 'vitest'
import { anonClient, signUp } from './users'

// plan_limits and get_plan_limits (ARCHITECTURE.md sections 4.1 and 4.2, PRD section 5, OQ-24,
// OQ-27): the plans and their prices, read only through get_plan_limits, signed in or not.

const PLANS = [
  { plan: 'free', pages_per_period: 20, monthly_price_usd: 0 },
  { plan: 'pro', pages_per_period: 500, monthly_price_usd: 19 },
]

describe('get_plan_limits', () => {
  it('gives anon and a signed-in user Free at 20 pages for $0 and Pro at 500 pages for $19', async () => {
    const user = await signUp()
    for (const client of [anonClient(), user.client]) {
      const { data, error } = await client.rpc('get_plan_limits')
      expect(error).toBeNull()
      expect(data).toEqual(PLANS)
    }
  })
})

describe('plan_limits', () => {
  it('cannot be read or written directly by anon or a signed-in user', async () => {
    const user = await signUp()
    for (const client of [anonClient(), user.client]) {
      const select = await client.from('plan_limits').select('plan')
      expect(select.error?.code).toBe('42501')
      const update = await client.from('plan_limits').update({ pages_per_period: 1000 }).eq('plan', 'free')
      expect(update.error?.code).toBe('42501')
      const insert = await client.from('plan_limits').insert({ plan: 'max', pages_per_period: 1, monthly_price_usd: 0 })
      expect(insert.error?.code).toBe('42501')
      const remove = await client.from('plan_limits').delete().eq('plan', 'pro')
      expect(remove.error?.code).toBe('42501')
    }
    expect((await anonClient().rpc('get_plan_limits')).data).toEqual(PLANS)
  })
})
