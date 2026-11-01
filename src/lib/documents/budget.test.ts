import { describe, expect, it } from 'vitest'
import { budgetSummary, type BudgetStatus } from './budget'

// The budget line on the document list (PRD US-12.1 AC-3, OQ-22, OQ-23, Lead ruling 1 on #48):
// "$x of $y used this month", and while a limit is reached, which one and when waiting documents
// resume, in the viewer's own time zone and locale.

const status = (o: Partial<BudgetStatus> = {}): BudgetStatus => ({
  spent_usd: 1.234567,
  cap_usd: 10,
  daily_reached: false,
  monthly_reached: false,
  resumes_at: null,
  ...o,
})

const GB_LONDON = { locale: 'en-GB', timeZone: 'Europe/London' }

describe('budgetSummary', () => {
  it('shows the spend rounded to cents and a whole cap without cents', () => {
    expect(budgetSummary(status(), GB_LONDON)).toEqual({ usage: '$1.23 of $10 used this month', notice: null })
  })

  it('rounds half a cent up, and shows cents on a cap that has them', () => {
    expect(budgetSummary(status({ spent_usd: 0.005, cap_usd: 12.5 }), GB_LONDON).usage).toBe('$0.01 of $12.50 used this month')
    expect(budgetSummary(status({ spent_usd: 2.675, cap_usd: 20 }), GB_LONDON).usage).toBe('$2.68 of $20 used this month')
    expect(budgetSummary(status({ spent_usd: 0, cap_usd: 10 }), GB_LONDON).usage).toBe('$0.00 of $10 used this month')
  })

  it('reads the numbers PostgREST may send as strings', () => {
    expect(budgetSummary(status({ spent_usd: '9.999' as never, cap_usd: '10.00' as never }), GB_LONDON).usage).toBe(
      '$10.00 of $10 used this month',
    )
  })

  it('says the daily limit is reached and the time waiting documents resume, as hour and minute', () => {
    const s = status({ daily_reached: true, resumes_at: '2026-11-11T00:00:00+00:00' })
    expect(budgetSummary(s, GB_LONDON).notice).toBe("Today's AI limit is reached. Waiting documents resume at 00:00.")
    expect(budgetSummary(s, { locale: 'en-GB', timeZone: 'Asia/Kolkata' }).notice).toBe(
      "Today's AI limit is reached. Waiting documents resume at 05:30.",
    )
    expect(budgetSummary(s, { locale: 'de-DE', timeZone: 'America/New_York' }).notice).toBe(
      "Today's AI limit is reached. Waiting documents resume at 19:00.",
    )
  })

  it('says the monthly cap is reached and the date waiting documents resume, as day and month', () => {
    const s = status({ spent_usd: 9.95, monthly_reached: true, resumes_at: '2026-12-01T00:00:00+00:00' })
    expect(budgetSummary(s, GB_LONDON).notice).toBe("This month's AI limit is reached. Waiting documents resume on 1 December.")
    expect(budgetSummary(s, { locale: 'en-US', timeZone: 'UTC' }).notice).toBe(
      "This month's AI limit is reached. Waiting documents resume on December 1.",
    )
    // West of UTC the first of the month starts on the evening of the 30th.
    expect(budgetSummary(s, { locale: 'en-GB', timeZone: 'America/Los_Angeles' }).notice).toBe(
      "This month's AI limit is reached. Waiting documents resume on 30 November.",
    )
  })

  it('gives the monthly sentence when both limits are reached', () => {
    const s = status({ daily_reached: true, monthly_reached: true, resumes_at: '2026-12-01T00:00:00+00:00' })
    expect(budgetSummary(s, GB_LONDON).notice).toBe("This month's AI limit is reached. Waiting documents resume on 1 December.")
  })

  it('shows no notice when neither limit is reached', () => {
    expect(budgetSummary(status({ resumes_at: null }), GB_LONDON).notice).toBeNull()
  })
})
