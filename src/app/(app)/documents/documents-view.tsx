'use client'

import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { FunctionsHttpError, type RealtimeChannel } from '@supabase/supabase-js'
import { UploadIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  allowanceSummary,
  channelLiveState,
  checkSelection,
  DOC_TYPE_LABELS,
  isListed,
  STATUS_LABELS,
  systemLiveState,
  type ListedStatus,
  type PageAllowance,
} from '@/lib/documents/upload'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

export interface DocumentItem {
  id: string
  file_name: string
  doc_type: string | null
  status: ListedStatus
  page_count: number | null
  created_at: string
}

interface Refusal {
  problems: string[]
  /** The whole selection was refused before anything was uploaded. */
  nothingUploaded: boolean
}

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp'

/** The message submit-document or an RPC refused with. */
async function reason(fileName: string, error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = await error.context.json().catch(() => null)
    if (typeof body?.error === 'string') return body.error
  }
  const message = (error as { message?: string } | null)?.message
  return `${fileName} could not be uploaded${message ? `: ${message}` : ''}. Try again.`
}

// The upload control and the workspace's document list (PRD US-1.1, US-10.1, US-13.2 AC-3,
// US-14.1 AC-4). Each chosen file becomes a document: create_document, the upload to the path it
// returns, then submit-document, which counts its pages and queues it. The list follows every
// change to the workspace's documents through Realtime, which sends only rows the user may read.
export function DocumentsView({
  workspace,
  initialDocuments,
  initialAllowance,
}: {
  workspace: { id: string; name: string }
  initialDocuments: DocumentItem[]
  initialAllowance: PageAllowance
}) {
  const supabase = useMemo(() => createClient(), [])
  const [documents, setDocuments] = useState(initialDocuments)
  const [allowance, setAllowance] = useState(initialAllowance)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [live, setLive] = useState('connecting')

  function upsert(doc: DocumentItem) {
    setDocuments((docs) =>
      [doc, ...docs.filter((d) => d.id !== doc.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    )
  }

  function remove(id: string) {
    setDocuments((docs) => docs.filter((d) => d.id !== id))
  }

  useEffect(() => {
    let cancelled = false
    let channel: RealtimeChannel | null = null

    // The channel must join as the user: Realtime checks the subscription against the token in the
    // join, and refuses it as anon. The client sets that token only when its auth state loads,
    // which can come after this effect, so set it from the session before subscribing.
    async function subscribe() {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (!data.session) {
        setLive('signed_out')
        return
      }
      await supabase.realtime.setAuth(data.session.access_token)
      if (cancelled) return
      channel = supabase
        .channel(`documents:${workspace.id}`)
        .on('system', {}, (message) => {
          const state = systemLiveState(message)
          if (state) setLive(state)
        })
        .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'documents', filter: `workspace_id=eq.${workspace.id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            remove((payload.old as { id: string }).id)
            return
          }
          const row = payload.new as DocumentItem & { workspace_id: string }
          if (row.workspace_id !== workspace.id) return
          if (isListed(row.status)) {
            upsert({
              id: row.id,
              file_name: row.file_name,
              doc_type: row.doc_type,
              status: row.status,
              page_count: row.page_count,
              created_at: row.created_at,
            })
          } else {
            remove(row.id)
          }
        },
      )
        .subscribe((status) => setLive(channelLiveState(status)))
    }

    void subscribe()
    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
    }
  }, [supabase, workspace.id])

  async function upload(files: File[]) {
    setRefusal(null)
    const problems = checkSelection(files)
    if (problems.length > 0) {
      setRefusal({ problems, nothingUploaded: true })
      return
    }

    const refused: string[] = []
    setProgress({ done: 0, total: files.length })
    for (const [i, file] of files.entries()) {
      const created = await supabase
        .rpc('create_document', { ws: workspace.id, file_name: file.name, mime_type: file.type, byte_size: file.size })
        .single<{ id: string; storage_path: string }>()
      if (created.error) {
        refused.push(await reason(file.name, created.error))
      } else {
        const stored = await supabase.storage
          .from('documents')
          .upload(created.data.storage_path, file, { contentType: file.type, upsert: false })
        if (stored.error) {
          refused.push(await reason(file.name, stored.error))
        } else {
          const submitted = await supabase.functions.invoke<{ document: { page_count: number } }>('submit-document', {
            body: { document_id: created.data.id },
          })
          if (submitted.error || !submitted.data) {
            refused.push(await reason(file.name, submitted.error))
          } else {
            upsert({
              id: created.data.id,
              file_name: file.name,
              doc_type: null,
              status: 'queued',
              page_count: submitted.data.document.page_count,
              created_at: new Date().toISOString(),
            })
          }
        }
      }
      setProgress({ done: i + 1, total: files.length })
    }
    setProgress(null)
    if (refused.length > 0) setRefusal({ problems: refused, nothingUploaded: false })

    const fresh = await supabase.rpc('get_page_allowance', { ws: workspace.id }).single<PageAllowance>()
    if (fresh.data) setAllowance(fresh.data)
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    if (progress) return
    void upload(Array.from(event.dataTransfer.files))
  }

  const left = allowanceSummary(allowance)

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="Upload documents"
        onDragEnter={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-8 text-center',
          dragging && 'border-primary bg-accent',
        )}
      >
        <UploadIcon className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Drop up to 10 files here, or choose them. PDF, JPEG, PNG or WebP, at most 10 MB and 10 pages each.
        </p>
        {/* The input is visually hidden, so its label shows the button's focus ring for it. */}
        <input
          id="upload-files"
          type="file"
          multiple
          accept={ACCEPT}
          disabled={progress !== null}
          className="peer sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void upload(files)
          }}
        />
        <label
          htmlFor="upload-files"
          className={cn(
            buttonVariants(),
            'peer-focus-visible:border-ring peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50',
            progress ? 'pointer-events-none opacity-50' : 'cursor-pointer',
          )}
        >
          Choose files
        </label>
        <p className="text-sm font-medium">Files are deleted 7 days after upload.</p>
        <p className="text-xs text-muted-foreground">
          {left.account} · {left.workspace}
        </p>
        {progress && (
          <p role="status" className="text-sm">
            Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}…
          </p>
        )}
      </section>

      {refusal && (
        <div role="alert" aria-label="Upload refused" className="grid gap-1 rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
          {refusal.problems.length === 1 ? (
            <p>
              {refusal.problems[0]}
              {refusal.nothingUploaded && ' Nothing was uploaded.'}
            </p>
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-5">
                {refusal.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {refusal.nothingUploaded && <p>Nothing was uploaded.</p>}
            </>
          )}
        </div>
      )}

      <span hidden data-testid="live-status" data-state={live} />
      {documents.length === 0 ? (
        <p className="text-muted-foreground">
          No documents in <span className="font-medium text-foreground">{workspace.name}</span> yet.
        </p>
      ) : (
        <div className="rounded-lg border">
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">Documents in {workspace.name}</caption>
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="w-24 px-3 py-2 font-medium sm:w-36">
                  Type
                </th>
                <th scope="col" className="w-24 px-3 py-2 font-medium sm:w-36">
                  Status
                </th>
                <th scope="col" className="w-14 px-3 py-2 text-right font-medium">
                  Pages
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="px-3 py-2 font-medium [overflow-wrap:anywhere]">{doc.file_name}</td>
                  <td className="px-3 py-2">{doc.doc_type ? (DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type) : ''}</td>
                  <td className="px-3 py-2">{STATUS_LABELS[doc.status]}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{doc.page_count ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
