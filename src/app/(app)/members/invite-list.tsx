'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { ROLE_LABELS, type Role } from '@/lib/workspace/members'
import { revokeInvite } from './actions'

export interface PendingInvite {
  id: string
  email: string
  role: Role
  expires: string
}

// Pending invitations, for an owner only (PRD US-8.2 AC-4). Revoking one makes its link stop
// working at once.
export function InviteList({ invites }: { invites: PendingInvite[] }) {
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  return (
    <section aria-labelledby="invites-heading" className="grid gap-3">
      <h2 id="invites-heading" className="text-lg font-semibold tracking-tight">
        Pending invitations
      </h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {invites.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending invitations.</p>
      ) : (
        <ul className="min-w-0 divide-y rounded-lg border">
          {invites.map((invite) => (
            <li key={invite.id} aria-label={invite.email} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{invite.email}</p>
                <p className="text-sm text-muted-foreground">
                  {ROLE_LABELS[invite.role]} · expires {invite.expires}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`Revoke the invitation for ${invite.email}`}
                onClick={() => {
                  setError(undefined)
                  startTransition(async () => setError((await revokeInvite(invite.id)).error))
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
