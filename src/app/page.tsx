import type { Metadata } from 'next'
import Link from 'next/link'
import { AccuracySection } from '@/components/landing/accuracy-section'
import { SiteFooter } from '@/components/site-footer'
import { buttonVariants } from '@/components/ui/button'
import { committedAccuracyTables } from '@/lib/landing/eval-results'
import { loadPlans } from '@/lib/landing/plans'
import { createAnonClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'doc-extract: business documents in, checked data out' }

// Statically rendered (PRD F15; issue #45, ruling 2): the eval results are read from eval/results/
// while the page is built, and the plans are fetched then too, and again at most once an hour. The
// page reads no cookie, so a signed-in visitor sees the same page.
export const revalidate = 3600

const STEPS = [
  { title: 'Upload', text: 'PDFs, phone photos or scans, up to 10 files at once and 10 pages per document.' },
  { title: 'Check', text: 'Claude extracts the fields. The app checks totals, dates and duplicates and flags what looks wrong.' },
  { title: 'Approve and export', text: 'Correct a value or accept it, approve the document, then download CSV or Excel.' },
]

const DOCUMENT_TYPES = ['Invoices', 'Receipts', 'Bank statements', 'Purchase orders', 'Delivery notes', 'Quotes']

export default async function HomePage() {
  const plans = await loadPlans(createAnonClient())
  const tables = committedAccuracyTables()

  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-12 px-4 py-12 sm:py-16">
        <section aria-labelledby="hero" className="flex flex-col gap-4">
          <h1 id="hero" className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Business documents in, checked data out
          </h1>
          <p className="text-lg text-muted-foreground">
            doc-extract reads invoices, receipts, bank statements, purchase orders, delivery notes and quotes with Claude. It
            returns every field and line item with a confidence, checks that the numbers add up, and puts anything doubtful in
            front of you before you approve and export to CSV or Excel.
          </p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex flex-col gap-2">
              <Link href="/demo" className={buttonVariants({ size: 'lg' })}>
                Try the demo
              </Link>
              <p className="text-sm text-muted-foreground">No sign-up. Sample documents, nothing saved.</p>
            </div>
            <Link href="/sign-in" className={buttonVariants({ size: 'lg', variant: 'outline' })}>
              Sign in
            </Link>
          </div>
        </section>

        <section aria-labelledby="how-it-works" className="flex flex-col gap-4">
          <h2 id="how-it-works" className="text-2xl font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="grid gap-3 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-1 rounded-xl border p-4">
                <span aria-hidden className="text-sm font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <h3 className="font-semibold">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="document-types" className="flex flex-col gap-4">
          <h2 id="document-types" className="text-2xl font-semibold tracking-tight">
            Six document types
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {DOCUMENT_TYPES.map((name) => (
              <li key={name} className="rounded-xl border px-4 py-3 font-medium">
                {name}
              </li>
            ))}
          </ul>
        </section>

        <AccuracySection tables={tables} />

        <section aria-labelledby="plans" className="flex flex-col gap-4">
          <h2 id="plans" className="text-2xl font-semibold tracking-tight">
            Plans
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 rounded-xl border p-4">
              <h3 className="font-semibold">Free</h3>
              <p className="text-sm text-muted-foreground">{plans.free.pages} pages a month per workspace</p>
              <p className="text-xl font-semibold">{plans.free.price}</p>
            </div>
            <div className="flex flex-col gap-1 rounded-xl border p-4">
              <h3 className="font-semibold">Pro</h3>
              <p className="text-sm text-muted-foreground">{plans.pro.pages} pages a month per workspace</p>
              <p className="text-xl font-semibold">{plans.pro.price} a month</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Billing runs in Stripe test mode: no real card is ever charged.</p>
          <p className="text-sm text-muted-foreground">
            On this site each account can process 10 pages of its own documents in total, so the demo stays within its AI budget.
          </p>
          <p className="text-sm text-muted-foreground">
            Uploaded files are deleted 7 days after upload. The extracted data stays until you delete the document, the workspace
            or your account.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
