import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { BillingView as BillingViewComponent } from './billing-view'

// The page's figures come only from its props, which the server reads from get_plan_limits and
// get_page_allowance (issue #50 criterion 9): values no plan has ever had must show as they are,
// and no real limit or price may be written in the page.

let BillingView: typeof BillingViewComponent

beforeAll(async () => {
  // The browser Supabase client's module throws at load without these; nothing is called here.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.invalid')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  BillingView = (await import('./billing-view')).BillingView
})

function render(plan: 'free' | 'pro') {
  return renderToStaticMarkup(
    createElement(BillingView, {
      workspace: { id: 'ws', name: 'Acme books' },
      isOwner: true,
      returnedFromCheckout: false,
      initialPlan: { plan, plan_period_end: null, plan_cancel_at_period_end: false },
      initialAllowance: { workspace_used: 7, workspace_limit: 77, account_used: 0, account_cap: 10 },
      plans: { free: { pages: 11, price: '$3' }, pro: { pages: 77, price: '$42' } },
    }),
  )
}

describe('BillingView', () => {
  it('shows each plan’s limit and price as given', () => {
    const html = render('free')
    expect(html).toContain('11 pages a month per workspace')
    expect(html).toContain('$3')
    expect(html).toContain('77 pages a month per workspace')
    expect(html).toContain('$42 a month')
  })

  it('shows the pages from the allowance as given', () => {
    const html = render('free')
    expect(html).toContain('70 of 77')
  })

  it('has no real limit or price of its own', () => {
    const html = render('pro')
    expect(html).not.toMatch(/\b500\b/)
    expect(html).not.toMatch(/\b20 pages\b/)
    expect(html).not.toContain('$19')
    expect(html).not.toContain('$0')
  })
})
