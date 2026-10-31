import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { buttonVariants } from '@/components/ui/button'
import { loadReview } from '@/lib/documents/load-review'
import { isReviewable, STATUS_LABELS, type ListedStatus } from '@/lib/documents/upload'
import { getWorkspaceContext } from '@/lib/workspace/server'
import { ReviewScreen } from './review-screen'

export const metadata: Metadata = { title: 'Review · doc-extract' }

// The review screen of one document (PRD F5), read as the user through RLS: a non-member, or a
// document that does not exist or was deleted, gets the not-found page and no data. Documents
// still on their way, or failed, are not opened for review (Lead ruling 3 on #32).
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase } = await getWorkspaceContext()
  const data = await loadReview(supabase, id)
  if (!data) notFound()

  const doc = data.document
  if (!isReviewable(doc.status)) {
    return (
      <main className="flex flex-col items-start gap-4">
        <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{doc.file_name}</h1>
        <p className="text-muted-foreground">
          It is {(STATUS_LABELS[doc.status as ListedStatus] ?? doc.status).toLowerCase()}, so there is nothing to review yet.
        </p>
        <Link href="/documents" className={buttonVariants({ variant: 'outline' })}>
          Back to documents
        </Link>
      </main>
    )
  }

  const { data: tolerance, error } = await supabase.rpc('get_amount_tolerance')
  if (error) throw error
  return <ReviewScreen key={doc.id} initial={data} amountTolerance={String(tolerance)} />
}
