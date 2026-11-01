import { describe, expect, it } from 'vitest'
import { pagesLeft, planEndDate } from './plan'

describe('planEndDate', () => {
  const end = '2030-03-14T23:30:00Z'

  it('is the date in UTC for a Pro plan set to end', () => {
    expect(planEndDate({ plan: 'pro', plan_period_end: end, plan_cancel_at_period_end: true })).toBe('14 March 2030')
  })

  it('is null while the subscription renews', () => {
    expect(planEndDate({ plan: 'pro', plan_period_end: end, plan_cancel_at_period_end: false })).toBeNull()
  })

  it('is null on Free, or with no period end', () => {
    expect(planEndDate({ plan: 'free', plan_period_end: end, plan_cancel_at_period_end: true })).toBeNull()
    expect(planEndDate({ plan: 'pro', plan_period_end: null, plan_cancel_at_period_end: true })).toBeNull()
  })
})

describe('pagesLeft', () => {
  it('is the allowance less the pages used', () => {
    expect(pagesLeft({ workspace_used: 3, workspace_limit: 20 })).toBe(17)
  })

  it('is never below zero, as after dropping to Free over the allowance', () => {
    expect(pagesLeft({ workspace_used: 30, workspace_limit: 20 })).toBe(0)
  })
})
