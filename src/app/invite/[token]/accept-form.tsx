'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import type { AcceptRefusal } from '@/lib/workspace/members'
import { acceptInvite } from './actions'

const REFUSALS: Record<AcceptRefusal, string> = {
  'not-for-you':
    'This invitation is not for you: it was made for another email address. Sign in with the Google account it was sent to.',
  'no-longer-valid':
    'This invitation is no longer valid: it has expired, been used or been revoked. Ask the owner for a new link.',
  'already-member': 'You are already a member of this workspace.',
  failed: 'The invitation could not be accepted. Try again.',
}

export function AcceptForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(acceptInvite, {})
  const refusal = state.refusal

  if (refusal && refusal !== 'failed') {
    return (
      <div className="grid gap-4">
        <p role="alert" className="text-sm text-destructive">
          {REFUSALS[refusal]}
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/documents">Go to your documents</Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      {refusal === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {REFUSALS.failed}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        Accept invitation
      </Button>
    </form>
  )
}
