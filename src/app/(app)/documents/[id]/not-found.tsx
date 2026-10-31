import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

// A document that does not exist, was deleted, or is in a workspace the user is not a member of:
// the same page for each, so it tells a non-member nothing (PRD US-19.1 AC-3).
export default function DocumentNotFound() {
  return (
    <main className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">This document does not exist</h1>
      <p className="text-muted-foreground">It may have been deleted, or it is in a workspace you are not a member of.</p>
      <Link href="/documents" className={buttonVariants({ variant: 'outline' })}>
        Back to documents
      </Link>
    </main>
  )
}
