'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { DELETE_FAILED, readMembers, soleMemberNote, sortAccountWorkspaces } from '@/lib/account/memberships'
import { createClient } from '@/lib/supabase/client'

// Deleting your own account (PRD US-18.2, OQ-30, issue #61 rulings 5, 6 and 8), in the header next
// to Sign out for every signed-in user, also one in no workspace.
export function DeleteAccount({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          Delete account
        </Button>
      </DialogTrigger>
      {/* Mounted per opening, so each one reads the workspaces again. */}
      <DialogContent>{open && <DeleteAccountForm userId={userId} />}</DialogContent>
    </Dialog>
  )
}

function DeleteAccountForm({ userId }: { userId: string }) {
  // null while reading; 'failed' when the read failed; otherwise the workspaces that go with the account.
  const [names, setNames] = useState<string[] | 'failed' | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    readMembers(createClient())
      .then((rows) => {
        if (current) setNames(sortAccountWorkspaces(rows, userId).soleMember.map((w) => w.name))
      })
      .catch((readError: unknown) => {
        console.error('The workspaces could not be read.', readError)
        if (current) setNames('failed')
      })
    return () => {
      current = false
    }
  }, [userId])

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      const response = await fetch('/api/account', { method: 'DELETE' })
      if (response.status === 204) {
        // A full navigation, so no cached page shows anything of the account (ruling 9).
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign('/')
        return
      }
      const body = response.status === 409 ? ((await response.json()) as { error?: string }) : null
      setError(body?.error ?? DELETE_FAILED)
    } catch {
      setError(DELETE_FAILED)
    }
    setPending(false)
  }

  return (
    <div className="grid gap-4 [overflow-wrap:anywhere]">
      <DialogHeader>
        <DialogTitle>Delete your account</DialogTitle>
        <DialogDescription>
          This deletes your account and cannot be undone. You leave every workspace you share; documents you uploaded
          there stay, shown as uploaded by a deleted user.
        </DialogDescription>
      </DialogHeader>
      {Array.isArray(names) && names.length > 0 && <p className="text-sm">{soleMemberNote(names)}</p>}
      {names === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load your workspaces. Try again.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        {names !== 'failed' && (
          <Button type="button" variant="destructive" disabled={names === null || pending} onClick={() => void confirm()}>
            Delete my account
          </Button>
        )}
      </DialogFooter>
    </div>
  )
}
