import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { safeNextPath } from '@/lib/auth/paths'
import { createClient } from '@/lib/supabase/server'
import { GoogleSignInButton } from './google-button'

export const metadata: Metadata = { title: 'Sign in · doc-extract' }

// One "Continue with Google" button and no email form (PRD US-9.1 AC-1). A visitor who is already
// signed in goes straight to the page they asked for.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const params = await searchParams
  const next = safeNextPath(params.next)

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) redirect(next)

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Sign in to doc-extract</h1>
          </CardTitle>
          <CardDescription>Use your Google account. A personal workspace is made for you on first sign-in.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {params.error && (
            <p role="alert" className="text-sm text-destructive">
              Sign-in did not complete. Try again.
            </p>
          )}
          <GoogleSignInButton next={next} />
        </CardContent>
      </Card>
      <nav aria-label="About" className="mt-4 flex justify-center gap-6 text-sm text-muted-foreground">
        <Link href="/privacy" className="underline-offset-4 hover:underline">
          Privacy
        </Link>
        <Link href="/terms" className="underline-offset-4 hover:underline">
          Terms
        </Link>
      </nav>
    </main>
  )
}
