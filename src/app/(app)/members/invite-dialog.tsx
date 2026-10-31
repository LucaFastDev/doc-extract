'use client'

import { useActionState, useRef, useState } from 'react'
import { UserPlusIcon } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { createInvite } from './actions'

// An owner invites an email address as owner or member (PRD US-8.2 AC-1, OQ-19, OQ-20). No email
// is sent: the dialog shows the link once, with a copy button, for the owner to pass on.
export function InviteDialog({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlusIcon />
          Invite
        </Button>
      </DialogTrigger>
      {/* Remounted each time it opens, so a link is never shown twice. */}
      <DialogContent>{open && <InviteForm workspaceId={workspaceId} />}</DialogContent>
    </Dialog>
  )
}

function InviteForm({ workspaceId }: { workspaceId: string }) {
  const [state, formAction, pending] = useActionState(createInvite, {})

  if (state.link) return <InviteLink link={state.link} email={state.email ?? ''} />

  return (
    <form action={formAction} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Invite someone</DialogTitle>
        <DialogDescription>
          You get a link for one email address. They join by opening it signed in with Google as that address.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="workspace" value={workspaceId} />
      <div className="grid gap-2">
        <Label htmlFor="invite-email">Email address</Label>
        <Input
          id="invite-email"
          name="email"
          type="email"
          required
          autoComplete="off"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'invite-error' : undefined}
        />
        {state.error && (
          <p id="invite-error" role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-3 text-sm leading-none font-medium">Role</legend>
        <RadioGroup name="role" defaultValue="member">
          <RoleChoice value="member" title="Member" description="Uploads, reviews, approves and exports documents." />
          <RoleChoice
            value="owner"
            title="Owner"
            description="Also invites people, manages members and billing, and renames the workspace."
          />
        </RadioGroup>
      </fieldset>
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          Create link
        </Button>
      </DialogFooter>
    </form>
  )
}

function RoleChoice({ value, title, description }: { value: string; title: string; description: string }) {
  const id = `invite-role-${value}`
  return (
    <div className="flex items-start gap-3">
      <RadioGroupItem value={value} id={id} className="mt-0.5" />
      <Label htmlFor={id} className="grid gap-1 leading-snug font-normal">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{description}</span>
      </Label>
    </div>
  )
}

function InviteLink({ link, email }: { link: string; email: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link)
      setCopy('copied')
    } catch {
      input.current?.select()
      setCopy('failed')
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Invitation link</DialogTitle>
        <DialogDescription>
          Send this link to <span className="font-medium text-foreground">{email}</span> yourself: no email is sent.
          It works for 7 days, once, and only for that address. It is shown only now.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="invite-link">Link</Label>
        <Input
          ref={input}
          id="invite-link"
          readOnly
          value={link}
          className="font-mono text-xs md:text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <p role="status" className="text-sm text-muted-foreground">
          {copy === 'copied' && 'Link copied.'}
          {copy === 'failed' && 'Copying did not work. The link is selected: copy it from there.'}
        </p>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Done
          </Button>
        </DialogClose>
        <Button type="button" onClick={copyLink}>
          {copy === 'copied' ? 'Copied' : 'Copy link'}
        </Button>
      </DialogFooter>
    </div>
  )
}
