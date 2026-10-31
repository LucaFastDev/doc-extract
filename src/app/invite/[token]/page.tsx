import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { signInPath } from '@/lib/auth/paths'
import { createClient } from '@/lib/supabase/server'
import { AcceptForm } from './accept-form'

export const metadata: Metadata = { title: 'Invitation · doc-extract' }

// An invitation's copy-link, <site>/invite/<token> (PRD US-8.2, OQ-18, OQ-19). A signed-out visitor
// is sent to sign-in and comes back here (OQ-34). Nothing changes until the user accepts, and the
// database decides whether the invitation is theirs and still valid.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect(signInPath(`/invite/${encodeURIComponent(token)}`))

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Join a workspace</h1>
          </CardTitle>
          <CardDescription>
            You have been invited to a workspace on doc-extract. Accepting adds you with the role its owner chose.
            You are signed in as <span className="font-medium break-all text-foreground">{user.email}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AcceptForm token={token} />
        </CardContent>
      </Card>
    </main>
  )
}
