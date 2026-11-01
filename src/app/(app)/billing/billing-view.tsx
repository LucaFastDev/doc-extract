'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PLAN_COLUMNS, PLAN_LABELS, pagesLeft, planEndDate, type WorkspacePlan } from '@/lib/billing/plan'
import type { PageAllowance } from '@/lib/documents/upload'
import type { Plans } from '@/lib/landing/plans'
import { createClient } from '@/lib/supabase/client'

// Lead ruling 5 on #50: shown to owners and members.
const NOTICE =
  'Billing here is a test-mode demonstration. Only Stripe test cards are accepted and no real money is ever charged. To try it, use the card 4242 4242 4242 4242 with any future date and any CVC.'

// Lead ruling 6 on #50: every 2 seconds for at most 20 seconds.
const RE_READ_MS = 2_000
const MAX_RE_READS = 10

const NO_CONNECTION = 'That did not work. Check your connection and try again.'

// The billing page (PRD US-11.1). A button asks its route for a Stripe URL and goes there; a failed
// call shows its message and leaves the plan as it was. On return from a completed Checkout, whose
// webhook may not have arrived yet, the page re-reads the plan until it turns Pro or the time is up.
export function BillingView({
  workspace,
  isOwner,
  returnedFromCheckout,
  initialPlan,
  initialAllowance,
  plans,
}: {
  workspace: { id: string; name: string }
  isOwner: boolean
  returnedFromCheckout: boolean
  initialPlan: WorkspacePlan
  initialAllowance: PageAllowance
  plans: Plans
}) {
  const [plan, setPlan] = useState(initialPlan)
  const [allowance, setAllowance] = useState(initialAllowance)
  const [reReading, setReReading] = useState(returnedFromCheckout && initialPlan.plan === 'free')
  const [stillFree, setStillFree] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    // The marker is spent once used, so a reload shows the plan as it is, with no timer.
    if (returnedFromCheckout) window.history.replaceState(null, '', '/billing')
  }, [returnedFromCheckout])

  useEffect(() => {
    if (!reReading) return
    const supabase = createClient()
    let stopped = false
    let reads = 0

    async function readPlan() {
      const [workspaceRow, allowanceRow] = await Promise.all([
        supabase.from('workspaces').select(PLAN_COLUMNS).eq('id', workspace.id).single<WorkspacePlan>(),
        supabase.rpc('get_page_allowance', { ws: workspace.id }).single<PageAllowance>(),
      ])
      if (workspaceRow.error) throw workspaceRow.error
      if (allowanceRow.error) throw allowanceRow.error
      return { plan: workspaceRow.data, allowance: allowanceRow.data }
    }

    const timer = setInterval(async () => {
      reads += 1
      const last = reads >= MAX_RE_READS
      if (last) clearInterval(timer)
      let upgraded = false
      try {
        const read = await readPlan()
        if (stopped) return
        upgraded = read.plan.plan === 'pro'
        if (upgraded) {
          clearInterval(timer)
          setPlan(read.plan)
          setAllowance(read.allowance)
          setReReading(false)
        }
      } catch (readError) {
        // The next re-read may work; the page still shows the plan it last read.
        console.error('The plan could not be re-read.', readError)
        if (stopped) return
      }
      if (last && !upgraded) {
        setReReading(false)
        setStillFree(true)
      }
    }, RE_READ_MS)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [reReading, workspace.id])

  async function goToStripe(path: string) {
    setError(undefined)
    setRedirecting(true)
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id }),
      })
      const body = await response.json().catch(() => null)
      if (response.ok && typeof body?.url === 'string') {
        window.location.assign(body.url)
        return
      }
      setError(typeof body?.error === 'string' ? body.error : NO_CONNECTION)
    } catch {
      setError(NO_CONNECTION)
    }
    setRedirecting(false)
  }

  const endDate = planEndDate(plan)

  return (
    <main className="flex flex-col gap-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-muted-foreground">
          The plan and pages of <span className="font-medium text-foreground">{workspace.name}</span>.
        </p>
      </div>

      <p className="rounded-lg border bg-muted px-4 py-3 text-sm">{NOTICE}</p>

      <section aria-labelledby="your-plan-heading" className="flex flex-col gap-4 rounded-xl border p-4">
        <h2 id="your-plan-heading" className="text-lg font-semibold tracking-tight">
          Your plan
        </h2>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Figure label="Current plan" value={PLAN_LABELS[plan.plan]} />
          <Figure label="Pages used this month" value={String(allowance.workspace_used)} />
          <Figure label="Pages left this month" value={`${pagesLeft(allowance)} of ${allowance.workspace_limit}`} />
        </dl>
        {endDate && <p className="text-sm">Your Pro plan ends on {endDate}.</p>}
        {reReading && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking your plan…
          </p>
        )}
        {stillFree && plan.plan === 'free' && (
          <p role="status" className="text-sm">
            Your payment went through. Your plan will update shortly.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {isOwner && (
          <div>
            {plan.plan === 'free' ? (
              <Button disabled={redirecting || reReading} onClick={() => goToStripe('/api/billing/checkout')}>
                Upgrade
              </Button>
            ) : (
              <Button variant="outline" disabled={redirecting} onClick={() => goToStripe('/api/billing/portal')}>
                Manage or cancel
              </Button>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="plans-heading" className="flex flex-col gap-4">
        <h2 id="plans-heading" className="text-lg font-semibold tracking-tight">
          Plans
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          <PlanCard name={PLAN_LABELS.free} pages={plans.free.pages} price={plans.free.price} />
          <PlanCard name={PLAN_LABELS.pro} pages={plans.pro.pages} price={`${plans.pro.price} a month`} />
        </ul>
      </section>
    </main>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
    </div>
  )
}

function PlanCard({ name, pages, price }: { name: string; pages: number; price: string }) {
  return (
    <li aria-label={name} className="flex flex-col gap-1 rounded-xl border p-4">
      <h3 className="font-semibold">{name}</h3>
      <p className="text-sm text-muted-foreground">{pages} pages a month per workspace</p>
      <p className="text-xl font-semibold">{price}</p>
    </li>
  )
}
