'use client'

import { useState, useTransition } from 'react'
import { EllipsisIcon, UserMinusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isLastOwner, ROLE_LABELS, type Role } from '@/lib/workspace/members'
import { removeMember, setMemberRole } from './actions'

export interface Member {
  userId: string
  name: string
  email: string
  role: Role
}

// The workspace's members (PRD US-8.2 AC-4 to AC-6, OQ-20). An owner changes roles and removes
// members; the last owner's row says why it has no controls. A member sees the list only.
export function MemberList({
  workspace,
  members,
  viewerId,
  canManage,
}: {
  workspace: { id: string; name: string }
  members: Member[]
  viewerId: string
  canManage: boolean
}) {
  const [error, setError] = useState<string>()
  const [removing, setRemoving] = useState<Member | null>(null)
  const [pending, startTransition] = useTransition()

  function run(change: () => Promise<{ error?: string }>) {
    setError(undefined)
    startTransition(async () => {
      const result = await change()
      setError(result.error)
    })
  }

  return (
    <section aria-labelledby="members-heading" className="grid gap-3">
      <h2 id="members-heading" className="text-lg font-semibold tracking-tight">
        Members
      </h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="divide-y rounded-lg border">
        {members.map((member) => {
          const lastOwner = isLastOwner(members, member.userId)
          return (
            <li key={member.userId} aria-label={member.name} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {member.name}
                  {member.userId === viewerId && <span className="font-normal text-muted-foreground"> (you)</span>}
                </p>
                {member.email !== member.name && (
                  <p className="truncate text-sm text-muted-foreground">{member.email}</p>
                )}
                {canManage && lastOwner && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    The only owner cannot be removed or made a member: a workspace needs at least one owner.
                  </p>
                )}
              </div>
              <span className="shrink-0 text-sm">{ROLE_LABELS[member.role]}</span>
              {canManage && !lastOwner && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" disabled={pending} aria-label={`Change ${member.name}`}>
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {member.role === 'member' ? (
                      <DropdownMenuItem
                        onSelect={() => run(() => setMemberRole(workspace.id, member.userId, 'owner'))}
                      >
                        Make owner
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => run(() => setMemberRole(workspace.id, member.userId, 'member'))}
                      >
                        Make member
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(member)}>
                      <UserMinusIcon />
                      Remove from workspace
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          )
        })}
      </ul>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          {removing && (
            <>
              <DialogHeader>
                <DialogTitle>Remove {removing.name}?</DialogTitle>
                <DialogDescription>
                  They lose access to {workspace.name} at once. Documents they uploaded stay in the workspace.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    const member = removing
                    setRemoving(null)
                    run(() => removeMember(workspace.id, member.userId))
                  }}
                >
                  Remove
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
