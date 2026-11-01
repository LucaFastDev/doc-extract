import { describe, expect, it } from 'vitest'
import { checkoutReturn, pagesLeft, planEndDate } from './plan'

describe('checkoutReturn', () => {
  const owner = { id: 'ws-1', role: 'owner' }

  it('acts on a return naming the current workspace, for an owner of it', () => {
    expect(checkoutReturn({ checkout: 'success', workspace: 'ws-1' }, owner)).toEqual({ spendMarker: true, actOnReturn: true })
  })

  it.each([
    ['names another workspace', { checkout: 'success', workspace: 'ws-2' }, owner],
    ['names no workspace', { checkout: 'success', workspace: undefined }, owner],
    ['names the workspace twice', { checkout: 'success', workspace: ['ws-1', 'ws-1'] }, owner],
    ['reaches a member', { checkout: 'success', workspace: 'ws-1' }, { id: 'ws-1', role: 'member' }],
  ])('spends the marker and does not act when the return %s', (_name, marker, current) => {
    expect(checkoutReturn(marker, current)).toEqual({ spendMarker: true, actOnReturn: false })
  })

  it.each([
    ['no marker', { checkout: undefined, workspace: undefined }],
    ['a workspace with no marker', { checkout: undefined, workspace: 'ws-1' }],
    ['another marker', { checkout: 'cancelled', workspace: 'ws-1' }],
  ])('leaves %s alone', (_name, marker) => {
    expect(checkoutReturn(marker, owner)).toEqual({ spendMarker: false, actOnReturn: false })
  })
})

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
