// The AI budget line on the document list (PRD US-12.1 AC-3, OQ-22, OQ-23, Lead ruling 1 on
// #48), from what get_budget_status returns. Signed-in members only: the demo and signed-out
// pages never ask for it.

/** What get_budget_status returns (ARCHITECTURE.md section 7). */
export interface BudgetStatus {
  spent_usd: number
  cap_usd: number
  daily_reached: boolean
  monthly_reached: boolean
  /** When waiting documents resume; null when neither limit is reached. */
  resumes_at: string | null
}

/** Rounds half a cent up. The spend has at most six decimals, so whole micro-dollars are exact. */
function cents(usd: number): number {
  return Math.round(Math.round(usd * 1e6) / 1e4)
}

function dollars(usd: number, keepCents: boolean): string {
  const c = cents(usd)
  return !keepCents && c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`
}

/**
 * "$1.23 of $10 used this month": the spend rounded to cents, the cap without cents when whole.
 * While a limit is reached, the notice says which and when waiting documents resume, in the
 * viewer's own time zone and locale: the time for the daily limit, the date for the monthly cap,
 * and the monthly sentence when both are reached. locale and timeZone are the viewer's when left
 * out; tests pass them.
 */
export function budgetSummary(status: BudgetStatus, options: { locale?: string; timeZone?: string } = {}) {
  const usage = `${dollars(Number(status.spent_usd), true)} of ${dollars(Number(status.cap_usd), false)} used this month`
  const resumes = status.resumes_at ? new Date(status.resumes_at) : null
  let notice: string | null = null
  if (resumes && status.monthly_reached) {
    const date = new Intl.DateTimeFormat(options.locale, { day: 'numeric', month: 'long', timeZone: options.timeZone }).format(resumes)
    notice = `This month's AI limit is reached. Waiting documents resume on ${date}.`
  } else if (resumes && status.daily_reached) {
    // The locale's own short time: hour and minute, as 00:00 in en-GB and 7:00 PM in en-US.
    const time = new Intl.DateTimeFormat(options.locale, { timeStyle: 'short', timeZone: options.timeZone }).format(resumes)
    notice = `Today's AI limit is reached. Waiting documents resume at ${time}.`
  }
  return { usage, notice }
}
