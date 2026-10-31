'use client'

import { useState, type ReactNode } from 'react'
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

// Deleting one document (PRD US-19.1, OQ-20): a confirmation that names the file, then
// DELETE /api/documents/[id]. Cancelling changes nothing; any member may delete any document.
export function DeleteDocument({
  document,
  trigger,
  onDeleted,
}: {
  document: { id: string; file_name: string }
  /** The button that opens the confirmation. */
  trigger: ReactNode
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      const response = await fetch(`/api/documents/${document.id}`, { method: 'DELETE' })
      if (response.status === 204) {
        setOpen(false)
        onDeleted()
        return
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? `${document.file_name} could not be deleted. Try again.`)
    } catch {
      setError(`${document.file_name} could not be deleted. Try again.`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {document.file_name}?</DialogTitle>
          <DialogDescription>
            Its file, fields, corrections, check results and history are deleted for everyone in the workspace. Pages it
            used are not given back.
          </DialogDescription>
        </DialogHeader>
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
          <Button type="button" variant="destructive" disabled={pending} onClick={() => void confirm()}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
