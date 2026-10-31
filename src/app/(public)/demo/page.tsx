import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRightIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { DEFAULT_PATH } from '@/lib/auth/paths'
import { listDemoSamples } from '@/lib/demo/sample'
import { DOC_TYPE_LABELS } from '@/lib/documents/upload'
import { createAnonClient, createClient } from '@/lib/supabase/server'
import { GoogleSignInButton } from '../../sign-in/google-button'

export const metadata: Metadata = { title: 'Demo · doc-extract' }

// The demo's samples (PRD F13, US-13.1 AC-2, AC-3 and AC-6; OQ-38), read as anon whoever is
// signed in, so RLS lists the published ones only, in sort_order. Uploading one's own documents
// needs an account: a visitor signs in with Google here, a signed-in user goes to their documents.
export default async function DemoPage() {
  const samples = await listDemoSamples(createAnonClient())
  const {
    data: { user },
  } = await (await createClient()).auth.getUser()

  return (
    <main className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Try doc-extract on sample documents</h1>
        <p className="text-muted-foreground">
          Each sample opens on the review screen with the result stored for it: its fields, line items, confidences, checks and
          flags. Correct a field, tick a check and export it; your changes stay in this browser tab, and nothing is saved. Every
          name, address and number in the samples is invented.
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {samples.map((s) => (
          <li key={s.slug}>
            <Link
              href={`/demo/${s.slug}`}
              className="flex h-full items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-medium [overflow-wrap:anywhere]">{s.title}</span>
                <span className="text-sm text-muted-foreground">
                  {DOC_TYPE_LABELS[s.doc_type] ?? s.doc_type} · {s.page_count} {s.page_count === 1 ? 'page' : 'pages'}
                </span>
                <span className="text-sm">{s.summary}</span>
              </div>
              <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>

      <section aria-labelledby="own-documents" className="flex flex-col gap-3 rounded-xl border p-4">
        <h2 id="own-documents" className="text-lg font-semibold tracking-tight">
          Your own documents
        </h2>
        {user ? (
          <>
            <p className="text-sm text-muted-foreground">You are signed in: upload your own documents from your document list.</p>
            <Link href={DEFAULT_PATH} className={buttonVariants({ className: 'w-full sm:w-fit' })}>
              Go to your documents
            </Link>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Uploading your own needs an account, with up to 10 pages per account. Sign in with Google to make one.
            </p>
            <div className="sm:w-fit">
              <GoogleSignInButton next={DEFAULT_PATH} label="Sign in with Google" />
            </div>
          </>
        )}
      </section>
    </main>
  )
}
