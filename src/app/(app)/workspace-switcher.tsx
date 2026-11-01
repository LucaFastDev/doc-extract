'use client'

import { useActionState, useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { ChevronsUpDownIcon, CreditCardIcon, PencilIcon, PlusIcon, UsersIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createWorkspace, renameWorkspace, switchWorkspace, type FormState } from './actions'

interface Workspace {
  id: string
  name: string
  role: 'owner' | 'member'
}

// Set when a workspace is created from NoWorkspace: that page, and the dialog trigger focus would
// return to, unmounts as the switcher replaces it, so the switcher takes focus when it mounts.
let focusOnMount = false

// The workspace switcher (PRD US-8.1 AC-3, AC-4): lists the user's workspaces, switches between
// them, creates one, lets an owner rename the current one, and opens its members (US-8.2) and its
// billing (US-11.1).
export function WorkspaceSwitcher({ workspaces, current }: { workspaces: Workspace[]; current: Workspace }) {
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null)
  const [pending, startTransition] = useTransition()
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (focusOnMount) {
      focusOnMount = false
      trigger.current?.focus()
    }
  }, [])

  return (
    <>
      {/* Not modal, so the dialogs it opens get the pointer back when it closes. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} variant="outline" className="max-w-full min-w-0 justify-between" disabled={pending}>
            <span className="sr-only">Workspace: </span>
            <span className="truncate">{current.name}</span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel className="text-muted-foreground">Workspaces</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current.id}
            onValueChange={(id) => startTransition(() => switchWorkspace(id))}
          >
            {workspaces.map((ws) => (
              <DropdownMenuRadioItem key={ws.id} value={ws.id}>
                <span className="truncate">{ws.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/members">
              <UsersIcon />
              Members
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/billing">
              <CreditCardIcon />
              Billing
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('create')}>
            <PlusIcon />
            Create workspace
          </DropdownMenuItem>
          {current.role === 'owner' && (
            <DropdownMenuItem onSelect={() => setDialog('rename')}>
              <PencilIcon />
              Rename workspace
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {/* The dialogs open from menu items, not from a trigger of their own, so on close focus
            is sent back to the switcher's button rather than left on <body>. */}
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
        >
          {dialog === 'create' && <CreateForm onDone={() => setDialog(null)} />}
          {dialog === 'rename' && <RenameForm workspace={current} onDone={() => setDialog(null)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

// What a user in no workspace sees in place of the page (PRD US-8.1 AC-3): the way to create one.
export function NoWorkspace() {
  const [open, setOpen] = useState(false)
  return (
    <main className="flex flex-col items-start gap-4">
      <p>You are not in any workspace.</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>Create workspace</Button>
        </DialogTrigger>
        <DialogContent>{open && <CreateForm action={createAndHandOffFocus} onDone={() => setOpen(false)} />}</DialogContent>
      </Dialog>
    </main>
  )
}

function useClosingAction(action: (prev: FormState, data: FormData) => Promise<FormState>, onDone: () => void) {
  const [state, formAction, pending] = useActionState(action, {})
  useEffect(() => {
    if (state.ok) onDone()
  }, [state, onDone])
  return { state, formAction, pending }
}

// The server response that creates the workspace also swaps NoWorkspace for the switcher, so the
// hand-off is set here, before that render, not in a close handler that would never run.
async function createAndHandOffFocus(prev: FormState, data: FormData) {
  const state = await createWorkspace(prev, data)
  if (state.ok) focusOnMount = true
  return state
}

function CreateForm({
  action = createWorkspace,
  onDone,
}: {
  action?: (prev: FormState, data: FormData) => Promise<FormState>
  onDone: () => void
}) {
  const { state, formAction, pending } = useClosingAction(action, onDone)
  return (
    <form action={formAction} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Create workspace</DialogTitle>
        <DialogDescription>You will be its owner, and it opens once created.</DialogDescription>
      </DialogHeader>
      <NameField defaultValue="" error={state.error} />
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          Create
        </Button>
      </DialogFooter>
    </form>
  )
}

function RenameForm({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const { state, formAction, pending } = useClosingAction(renameWorkspace, onDone)
  return (
    <form action={formAction} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename workspace</DialogTitle>
        <DialogDescription>Every member sees the new name.</DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={workspace.id} />
      <NameField defaultValue={workspace.name} error={state.error} />
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}

function NameField({ defaultValue, error }: { defaultValue: string; error?: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="workspace-name">Name</Label>
      <Input
        id="workspace-name"
        name="name"
        defaultValue={defaultValue}
        required
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'workspace-name-error' : undefined}
      />
      {error && (
        <p id="workspace-name-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
