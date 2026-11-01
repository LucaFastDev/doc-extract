import type { Metadata } from 'next'
import { PLAN_COLUMNS, type WorkspacePlan } from '@/lib/billing/plan'
import type { PageAllowance } from '@/lib/documents/upload'
import { loadPlans } from '@/lib/landing/plans'
import { getWorkspaceContext } from '@/lib/workspace/server'
import { BillingView } from './billing-view'

export const metadata: Metadata = { title: 'Billing · doc-extract' }

// The current workspace's plan and pages, with each plan's limits and price from get_plan_limits
// (PRD US-11.1). Read as the user, through RLS: owners and members both see this; only an owner gets
// the buttons, and the routes behind them check is_owner themselves (OQ-20).
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string | string[] }> }) {
  const { supabase, current } = await getWorkspaceContext()
  if (!current) return null

  const { data: plan, error } = await supabase
    .from('workspaces')
    .select(PLAN_COLUMNS)
    .eq('id', current.id)
    .single<WorkspacePlan>()
  if (error) throw error

  const { data: allowance, error: allowanceError } = await supabase
    .rpc('get_page_allowance', { ws: current.id })
    .single<PageAllowance>()
  if (allowanceError) throw allowanceError

  const plans = await loadPlans(supabase)
  const { checkout } = await searchParams

  return (
    <BillingView
      key={current.id}
      workspace={{ id: current.id, name: current.name }}
      isOwner={current.role === 'owner'}
      returnedFromCheckout={checkout === 'success'}
      initialPlan={plan}
      initialAllowance={allowance}
      plans={plans}
    />
  )
}
