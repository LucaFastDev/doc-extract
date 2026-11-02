// A workspace's plan as the billing page shows it (PRD US-11.1). Plain, so the page's server and
// client parts share it.

/** The columns of `workspaces` the page reads, as the user, through RLS. */
export const PLAN_COLUMNS = 'plan, plan_period_end, plan_cancel_at_period_end'

export interface WorkspacePlan {
  plan: 'free' | 'pro'
  plan_period_end: string | null
  plan_cancel_at_period_end: boolean
}

export const PLAN_LABELS: Record<WorkspacePlan['plan'], string> = { free: 'Free', pro: 'Pro' }

// UTC, so the server and the browser render the same date, and the plan's day is Stripe's.
const END_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** The date a Pro plan set to end ends on; null while it renews or on Free. */
export function planEndDate(plan: WorkspacePlan): string | null {
  if (plan.plan !== 'pro' || !plan.plan_cancel_at_period_end || !plan.plan_period_end) return null
  return END_DATE.format(new Date(plan.plan_period_end))
}

type SearchParam = string | string[] | undefined

/**
 * What the billing page does with the return marker in its address (Lead ruling 8 on #50, issue 87).
 * `spendMarker`: any return takes it out, the workspace and the session id with it. `sessionId`, set
 * only when the page acts on the return: the check with Stripe, the re-reads and the message they can
 * end in belong only to the workspace that went to Checkout, only to an owner of it, and only to a
 * return naming one session; every other return gets the plain page.
 */
export function checkoutReturn(
  marker: { checkout: SearchParam; workspace: SearchParam; session_id: SearchParam },
  current: { id: string; role: string },
): { spendMarker: boolean; sessionId: string | null } {
  const spendMarker = marker.checkout === 'success'
  const actOnReturn = spendMarker && marker.workspace === current.id && current.role === 'owner'
  return { spendMarker, sessionId: actOnReturn && typeof marker.session_id === 'string' ? marker.session_id : null }
}

/** Pages left this month: never below zero, as after dropping to Free over the allowance (US-11.1 AC-7). */
export function pagesLeft(allowance: { workspace_used: number; workspace_limit: number }): number {
  return Math.max(0, allowance.workspace_limit - allowance.workspace_used)
}
