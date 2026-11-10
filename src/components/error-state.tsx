import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'

// What src/app/error.tsx and src/app/global-error.tsx show (issue #132, criterion 3), in the style
// of the not-found page. It never shows the error itself: its message or stack can name internals,
// and Next.js logs it on the server already.
export function ErrorState({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col items-start gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong.</h1>
      <p className="text-muted-foreground">Try again, or go back to your documents.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Link href="/documents" className={buttonVariants({ variant: 'outline' })}>
          Go to your documents
        </Link>
      </div>
    </main>
  )
}
