import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

// An address that is no page of ours, for a signed-in or a signed-out visitor. A route with a
// not-found page of its own, such as a document, shows that one instead.
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col items-start gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">This page does not exist or has moved.</p>
      <Link href="/" className={buttonVariants({ variant: 'outline' })}>
        Go to the home page
      </Link>
    </main>
  )
}
