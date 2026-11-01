// The plans the landing page shows (PRD F15 AC-2, OQ-27): get_plan_limits(), which `anon` may
// call, so a visitor who is not signed in sees them (ARCHITECTURE.md section 4.2).

export interface PlanLimitsClient {
  rpc(fn: 'get_plan_limits'): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export interface PlanOffer {
  pages: number
  /** `$0`, `$19`. */
  price: string
}

export interface Plans {
  free: PlanOffer
  pro: PlanOffer
}

/** `$19` for a whole-dollar price, `$9.50` otherwise. */
export function formatPrice(usd: number | string): string {
  const value = Number(usd)
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`
}

/** Free and Pro as get_plan_limits() gives them; fails, rather than show wrong plans, on anything else. */
export async function loadPlans(client: PlanLimitsClient): Promise<Plans> {
  const { data, error } = await client.rpc('get_plan_limits')
  if (error) throw new Error(`get_plan_limits failed: ${error.message}`)
  const rows = Array.isArray(data) ? (data as { plan: string; pages_per_period: number; monthly_price_usd: number | string }[]) : []
  const offer = (plan: 'free' | 'pro'): PlanOffer => {
    const row = rows.find((r) => r.plan === plan)
    if (!row) throw new Error(`get_plan_limits has no ${plan} plan`)
    return { pages: row.pages_per_period, price: formatPrice(row.monthly_price_usd) }
  }
  return { free: offer('free'), pro: offer('pro') }
}
