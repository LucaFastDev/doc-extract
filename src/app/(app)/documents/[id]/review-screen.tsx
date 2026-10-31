'use client'

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { utcDate } from '@shared/doctypes/checks'
import type { DocTypeDef } from '@shared/doctypes/doctype'
import type { CheckResult } from '@shared/doctypes/fields'
import { DOC_TYPES } from '@shared/doctypes/index'
import { currentValue, listChecks } from '@shared/doctypes/review'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { changeQueue } from '@/lib/documents/change-queue'
import { loadReview, type ReviewData, type ReviewDocument } from '@/lib/documents/load-review'
import {
  addLine,
  applyCorrection,
  correctionFor,
  deleteLine,
  EVENT_LABELS,
  eventActor,
  fieldLabel,
  flagReasons,
  formatConfidence,
  formatTime,
  groupFields,
  isDocType,
  lineWord,
  liveReview,
  saveFailure,
  storedReview,
  untickedFailures,
  type Review,
  type ReviewRow,
} from '@/lib/documents/review'
import { sectionHold } from '@/lib/documents/section-hold'
import { DOC_TYPE_LABELS, STATUS_LABELS, type ListedStatus } from '@/lib/documents/upload'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { DeleteDocument } from '../delete-document'
import { DocumentViewer } from './document-viewer'

const CHECK_STATUS = { pass: 'Passed', fail: 'Failed', skipped: 'Skipped' } as const

/** Whether the focus is in one of the fields or cells, where the user may be typing. */
const inField = () => document.activeElement?.closest('[data-field]') != null

/** The message an RPC or an Edge Function refused with, when it wrote one for the user. */
async function refusal(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = await error.context.json().catch(() => null)
    if (typeof body?.error === 'string') return body.error
  }
  const e = error as { code?: string; message?: string } | null
  return e?.code === '22023' && e.message ? e.message : fallback
}

// The review screen (PRD F5, US-1.2 AC-4 to AC-6, US-4.1, F14, F19; OQ-1, OQ-11, OQ-12, OQ-40,
// OQ-44): the document beside its fields, flagged fields first; corrections and line items saved
// as they are made, with the checks re-run in the browser after each; a tick for each failed
// check; approval through approve-document; reopen, type change and delete. Every read and write
// is the signed-in member's, through RLS and the review RPCs.
export function ReviewScreen({ initial, amountTolerance }: { initial: ReviewData; amountTolerance: string }) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [data, setData] = useState(initial)
  const [rows, setRows] = useState(initial.fields)
  const [ticks, setTicks] = useState(() => new Set(initial.ticks))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [today] = useState(() => utcDate(new Date()))
  // While the user is in a field, the fields stay in the sections they were in when they went in:
  // a save that clears or adds flags would otherwise move the field they are in to another
  // section, which mounts it again and loses the focus and what they type. The reasons and the
  // checks still update live. null: the sections follow the live flags.
  const [layout, setLayout] = useState<Review['flags'] | null>(null)
  // Counts the refusals: each one puts the stored values back in the fields the user is not in.
  const [revision, setRevision] = useState(0)

  const doc = data.document
  const def = isDocType(doc.doc_type) ? DOC_TYPES[doc.doc_type] : null
  const editable = doc.status === 'needs_review'
  const review = useMemo<Review | null>(() => {
    if (!def) return null
    return editable ? liveReview(def, rows, data.checks, { amountTolerance, today }) : storedReview(rows, data.checks)
  }, [def, editable, rows, data.checks, amountTolerance, today])
  const unticked = review ? untickedFailures(review.checks, ticks) : []

  async function reload() {
    const fresh = await loadReview(supabase, doc.id)
    if (!fresh) {
      router.refresh()
      return
    }
    setData(fresh)
    setRows(fresh.fields)
    setTicks(new Set(fresh.ticks))
  }

  // The sections follow the flags again once the focus has really left the fields and every change
  // has finished; moving from one field to another, by click or Tab, keeps them held.
  const [hold] = useState(() => sectionHold(inField, () => setLayout(null)))
  useEffect(() => {
    // The field whose label, border or padding a press started on. A press there ends in that field:
    // if the release leaves no field focused, the field takes the focus, before the hold checks it.
    let pressed: string | null = null
    const press = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null
      pressed = e.button === 0 && !target?.closest('input') ? (target?.closest('[data-field]')?.getAttribute('data-field') ?? null) : null
      hold.press()
    }
    const lift = () => {
      const path = pressed
      pressed = null
      if (path !== null) {
        setTimeout(() => {
          if (!inField()) document.querySelector<HTMLInputElement>(`[data-field="${CSS.escape(path)}"] input`)?.focus()
        })
      }
      hold.lift()
    }
    const cancel = () => {
      pressed = null
      hold.lift()
    }
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('pointerup', lift, true)
    window.addEventListener('pointercancel', cancel, true)
    return () => {
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('pointerup', lift, true)
      window.removeEventListener('pointercancel', cancel, true)
    }
  }, [hold])

  // Changes run one at a time, in the order they were made. A field's save on blur does not disable
  // the buttons: the click that blurred the field still lands, and its action runs after the save.
  const [queue] = useState(() =>
    changeQueue(() => {
      setBusy(false)
      hold.idle()
    }),
  )

  /**
   * Runs one change after those before it; a refusal is shown, the changes waiting behind it are
   * dropped, and the screen reloads so it shows what is stored. A dropped change puts the stored
   * values back too, so a field left after the refusal does not keep an unsaved value. A clicked
   * action disables the buttons until every change has finished.
   */
  function act(change: () => Promise<string | null>, { fromButton = true } = {}) {
    if (fromButton) setBusy(true)
    hold.busy()
    let ran = false
    return queue(async () => {
      ran = true
      setError(null)
      try {
        const refused = await change()
        if (!refused) return true
        setError(refused)
        setRevision((n) => n + 1)
        // The refusal stays shown if the reload fails too.
        await reload().catch((e) => console.error('The review could not be reloaded.', e))
      } catch (e) {
        console.error('A review change failed.', e)
        setError('That change could not be saved. Reload the page and try again.')
        setRevision((n) => n + 1)
      }
      return false
    }).then((stored) => {
      if (!ran) setRevision((n) => n + 1)
      return stored
    })
  }

  const saveField = (row: ReviewRow, typed: string) =>
    act(async () => {
      const corrected = correctionFor(row, typed)
      if (corrected === row.corrected_value) return null
      try {
        const { data: saved, error } = await supabase
          .from('extraction_fields')
          .update({ corrected_value: corrected })
          .eq('document_id', doc.id)
          .eq('path', row.path)
          .select('path')
        if (!error && saved?.length) {
          setRows((r) => applyCorrection(r, row.path, corrected))
          return null
        }
        if (error) console.error('A correction could not be saved.', error)
      } catch (e) {
        console.error('A correction could not be saved.', e)
      }
      // RLS updates no row once the document no longer needs review; its status says whether that is
      // why. One read, not retried, so the message is not held back seconds on a network error.
      const current = await supabase
        .from('documents')
        .select('status')
        .eq('id', doc.id)
        .retry(false)
        .maybeSingle<{ status: string }>()
        .then(({ data }) => data?.status ?? null, () => null)
      return saveFailure(fieldLabel(def!, row.path), current)
    }, { fromButton: false })

  const addLineAfter = (after: number) =>
    act(async () => {
      const { error } = await supabase.rpc('add_line_item', { document_id: doc.id, after_position: after })
      if (error) return refusal(error, 'The line could not be added. Try again.')
      setRows((r) => addLine(r, def!.lineFields, after))
      return null
    })

  const removeLine = (index: number) =>
    act(async () => {
      const { error } = await supabase.rpc('delete_line_item', { document_id: doc.id, line_position: index })
      if (error) return refusal(error, 'The line could not be deleted. Try again.')
      setRows((r) => deleteLine(r, index))
      return null
    })

  const setTicked = (checkId: string, ticked: boolean) =>
    act(async () => {
      const { error } = await supabase.rpc('set_check_ticked', { document_id: doc.id, check_id: checkId, ticked })
      if (error) return refusal(error, `${checkId} could not be ticked. Try again.`)
      setTicks((t) => {
        const next = new Set(t)
        if (ticked) next.add(checkId)
        else next.delete(checkId)
        return next
      })
      return null
    })

  const approve = () =>
    act(async () => {
      const { error } = await supabase.functions.invoke('approve-document', { body: { document_id: doc.id } })
      if (error) return refusal(error, `${doc.file_name} could not be approved. Try again.`)
      await reload()
      return null
    })

  const reopen = () =>
    act(async () => {
      const { error } = await supabase.rpc('reopen_document', { document_id: doc.id })
      if (error) return refusal(error, `${doc.file_name} could not be reopened. Try again.`)
      await reload()
      return null
    })

  const canChangeType = (doc.status === 'needs_review' || doc.status === 'unsupported') && !doc.file_deleted_at

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link href="/documents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" aria-hidden />
            Documents
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{doc.file_name}</h1>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <Detail term="Type">{doc.doc_type ? (DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type) : 'None'}</Detail>
            <Detail term="Status">{STATUS_LABELS[doc.status as ListedStatus] ?? doc.status}</Detail>
            {doc.page_count !== null && <Detail term="Pages">{doc.page_count}</Detail>}
          </dl>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canChangeType && <ChangeType document={doc} onChanged={() => router.push('/documents')} />}
          <DeleteDocument
            document={doc}
            onDeleted={() => router.push('/documents')}
            trigger={
              <Button type="button" variant="outline">
                <Trash2Icon aria-hidden />
                Delete
              </Button>
            }
          />
        </div>
      </div>

      {doc.status === 'approved' && (
        <div className="flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm" data-testid="approval">
            Approved by <span className="font-medium">{doc.approved_by ? (data.people[doc.approved_by] ?? 'a member') : 'a deleted user'}</span>
            {doc.approved_at && <> on {formatTime(doc.approved_at)}</>}
          </p>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void reopen()}>
            Reopen
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="min-w-0 lg:sticky lg:top-4">
          {doc.file_deleted_at || !doc.storage_path ? (
            <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
              The file was deleted 7 days after upload
              {doc.file_deleted_at && <>, on {formatTime(doc.file_deleted_at)}</>}. Its fields, checks and history are kept.
            </p>
          ) : (
            <DocumentViewer storagePath={doc.storage_path} mimeType={doc.mime_type} fileName={doc.file_name} />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {doc.status === 'unsupported' || !def || !review ? (
            <p className="rounded-lg border px-4 py-3 text-sm">
              {doc.status_reason ?? 'This is not a supported document type.'}{' '}
              {canChangeType
                ? 'If it is one of the six types, change its type to extract it again as that type.'
                : 'Its file has been deleted, so its type can no longer be changed.'}
            </p>
          ) : (
            <>
              <HeldBox held={layout !== null} reorders>
                <Checks
                  checks={review.checks}
                  ticks={ticks}
                  editable={editable}
                  busy={busy}
                  onTick={(id, ticked) => void setTicked(id, ticked)}
                />
              </HeldBox>
              {editable && (
                <HeldBox held={layout !== null} reorders className="flex flex-col gap-2">
                  <Button type="button" className="self-start" disabled={busy || unticked.length > 0} onClick={() => void approve()}>
                    Approve
                  </Button>
                  {unticked.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      Tick {listChecks(unticked)} to approve, or correct the fields until {unticked.length === 1 ? 'it passes' : 'they pass'}.
                    </p>
                  )}
                </HeldBox>
              )}
              <Fields
                def={def}
                rows={rows}
                review={review}
                held={layout !== null}
                layout={layout ?? review.flags}
                revision={revision}
                editable={editable}
                busy={busy}
                onEnter={() => setLayout((held) => held ?? review.flags)}
                onSave={(row, typed) => void saveField(row, typed)}
                onAddLine={(after) => void addLineAfter(after)}
                onDeleteLine={(index) => void removeLine(index)}
              />
            </>
          )}
          <History data={data} />
        </div>
      </div>
    </main>
  )
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Every check with its state and message; a failed one has its tick box (US-4.1, US-5.1 AC-5). */
function Checks({
  checks,
  ticks,
  editable,
  busy,
  onTick,
}: {
  checks: CheckResult[]
  ticks: Set<string>
  editable: boolean
  busy: boolean
  onTick: (checkId: string, ticked: boolean) => void
}) {
  const order = { fail: 0, skipped: 1, pass: 2 } as const
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status] || a.check_id.localeCompare(b.check_id))
  return (
    <Section title="Checks">
      <ul className="divide-y rounded-lg border">
        {sorted.map((c) => (
          <li key={c.check_id} data-check={c.check_id} data-status={c.status} className="flex flex-col gap-2 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{c.check_id}</span>
              <span className={cn(c.status === 'fail' ? 'text-destructive' : 'text-muted-foreground')}>{CHECK_STATUS[c.status]}</span>
            </div>
            {c.message && <p className="text-muted-foreground [overflow-wrap:anywhere]">{c.message}</p>}
            {c.status === 'fail' && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`tick-${c.check_id}`}
                  checked={ticks.has(c.check_id)}
                  disabled={!editable || busy}
                  onCheckedChange={(v) => onTick(c.check_id, v === true)}
                />
                <Label htmlFor={`tick-${c.check_id}`}>Tick {c.check_id}</Label>
                <span className="text-xs text-muted-foreground">I checked it, and approve it as it is.</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * Flagged fields and cells first, each with its reasons, then the other fields, then each line
 * (US-5.1 AC-2 to AC-4). The sections come from `layout`, the reasons from the live review.
 */
function Fields({
  def,
  rows,
  review,
  held,
  layout,
  revision,
  editable,
  busy,
  onEnter,
  onSave,
  onAddLine,
  onDeleteLine,
}: {
  def: DocTypeDef
  rows: ReviewRow[]
  review: Review
  held: boolean
  layout: Review['flags']
  revision: number
  editable: boolean
  busy: boolean
  onEnter: () => void
  onSave: (row: ReviewRow, typed: string) => void
  onAddLine: (after: number) => void
  onDeleteLine: (index: number) => void
}) {
  const groups = groupFields(def, rows, layout)
  const word = lineWord(def)
  const entry = (row: ReviewRow) => (
    <FieldEntry
      key={row.path}
      def={def}
      row={row}
      reasons={flagReasons(row, review.flags[row.path] ?? [], review.checks, rows)}
      held={held}
      revision={revision}
      editable={editable}
      onEnter={onEnter}
      onSave={onSave}
    />
  )
  return (
    <>
      {groups.flagged.length > 0 && (
        <HeldBox held={held}>
          <Section title="Flagged fields">
            <div className="grid gap-3">{groups.flagged.map(entry)}</div>
          </Section>
        </HeldBox>
      )}
      <HeldBox held={held}>
        <Section title="Fields">
          <div className="grid gap-3 sm:grid-cols-2">{groups.fields.map(entry)}</div>
        </Section>
      </HeldBox>
      <HeldBox held={held}>
        <Section
          title={def.linesKey === 'transactions' ? 'Transactions' : 'Line items'}
          action={
            editable && (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onAddLine(groups.lines.length - 1)}>
                <PlusIcon aria-hidden />
                Add {word.toLowerCase()}
              </Button>
            )
          }
        >
          {groups.lines.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
          {groups.lines.map((cells, i) => (
            <section key={i} aria-label={`${word} ${i + 1}`} className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                  {word} {i + 1}
                </h3>
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Delete ${word.toLowerCase()} ${i + 1}`}
                    onClick={() => onDeleteLine(i)}
                  >
                    <Trash2Icon aria-hidden />
                    Delete
                  </Button>
                )}
              </div>
              {cells.length < def.lineFields.length && (
                <p className="text-xs text-muted-foreground">Its flagged cells are listed under Flagged fields.</p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">{cells.map(entry)}</div>
            </section>
          ))}
        </Section>
      </HeldBox>
    </>
  )
}

/**
 * While the section hold is active, the element keeps at least the height it had when the hold
 * began, and its content updates inside it, so nothing below it moves under a press. Once the hold
 * releases, the height is freed. `reorders`: its content can move inside it, so the browser's
 * scroll anchoring must not follow it, or the page scrolls under the pointer instead.
 */
function useHeldHeight<T extends HTMLElement>(held: boolean, reorders = false) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.minHeight = held ? `${el.getBoundingClientRect().height}px` : ''
    if (reorders) el.style.overflowAnchor = held ? 'none' : ''
  }, [held, reorders])
  return ref
}

function HeldBox({ held, reorders, className, children }: { held: boolean; reorders?: boolean; className?: string; children: ReactNode }) {
  const box = useHeldHeight<HTMLDivElement>(held, reorders)
  return (
    <div ref={box} className={className}>
      {children}
    </div>
  )
}

/** One field or cell: its value, editable while the document needs review, the extracted value beside a correction, its confidence and reasons. */
function FieldEntry({
  def,
  row,
  reasons,
  held,
  revision,
  editable,
  onEnter,
  onSave,
}: {
  def: DocTypeDef
  row: ReviewRow
  reasons: string[]
  held: boolean
  revision: number
  editable: boolean
  onEnter: () => void
  onSave: (row: ReviewRow, typed: string) => void
}) {
  const id = useId()
  // A field whose reasons clear keeps its height while the sections are held, so the fields after it stay put.
  const box = useHeldHeight<HTMLDivElement>(held)
  const input = useRef<HTMLInputElement>(null)
  // Set between a click's focus and its mouseup, which would otherwise undo the selection.
  const clickedIn = useRef(false)
  const value = currentValue(row) ?? ''
  const label = fieldLabel(def, row.path)
  // The stored value, once it changes or a save is refused; the field the user is in keeps what they type.
  useEffect(() => {
    if (input.current && input.current !== document.activeElement) input.current.value = value
  }, [value, revision])
  return (
    <div ref={box} data-field={row.path} className={cn('flex min-w-0 flex-col gap-1.5 rounded-md border p-3', reasons.length > 0 && 'border-destructive/50')}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="[overflow-wrap:anywhere]">
          {label}
        </Label>
        <span className="shrink-0 text-xs text-muted-foreground">Confidence {formatConfidence(row.confidence)}</span>
      </div>
      {editable ? (
        <Input
          ref={input}
          id={id}
          defaultValue={value}
          autoComplete="off"
          // Going into a field selects its value, by a click as by Tab, so what is typed replaces it.
          onMouseDown={(e) => {
            clickedIn.current = e.currentTarget !== document.activeElement
          }}
          onMouseUp={(e) => {
            if (clickedIn.current) e.preventDefault()
            clickedIn.current = false
          }}
          onFocus={(e) => {
            e.currentTarget.select()
            onEnter()
          }}
          onBlur={(e) => onSave(row, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      ) : (
        <p id={id} className="text-sm [overflow-wrap:anywhere]">
          {value || '—'}
        </p>
      )}
      {row.corrected_value !== null && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Extracted: {row.extracted_value ?? 'empty'}</p>
      )}
      {reasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-destructive">
          {reasons.map((r) => (
            <li key={r} className="[overflow-wrap:anywhere]">
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Every event of the document, newest first, with who and when (US-5.1 AC-7). */
function History({ data }: { data: ReviewData }) {
  return (
    <Section title="History">
      <ol className="flex flex-col gap-2 text-sm">
        {data.events.map((e) => (
          <li key={e.id} data-kind={e.kind}>
            <span className="font-medium">{EVENT_LABELS[e.kind] ?? e.kind}</span> by {eventActor(e, data.people)}
            <span className="text-muted-foreground">
              {' · '}
              <time dateTime={e.created_at}>{formatTime(e.created_at)}</time>
            </span>
          </li>
        ))}
      </ol>
    </Section>
  )
}

/** Pick one of the six types and confirm; the document is extracted again as that type (US-1.2 AC-4, AC-5, OQ-1). */
function ChangeType({ document, onChanged }: { document: ReviewDocument; onChanged: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setPending(true)
    setError(null)
    const { error } = await supabase.rpc('change_document_type', { document_id: document.id, doc_type: choice })
    setPending(false)
    if (error) {
      setError(await refusal(error, `The type of ${document.file_name} could not be changed. Try again.`))
      return
    }
    setOpen(false)
    onChanged()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setChoice('')
          setError(null)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Change type
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change the type of {document.file_name}</DialogTitle>
          <DialogDescription>
            {document.status === 'unsupported'
              ? 'It is extracted again as the type you choose. Its pages are held again, and count once the extraction succeeds.'
              : 'Its fields, corrections and ticked checks are discarded, and it is extracted again as the type you choose. No further pages are counted.'}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={choice} onValueChange={setChoice} aria-label="Document type">
          {Object.entries(DOC_TYPE_LABELS).map(([type, label]) => (
            <div key={type} className="flex items-center gap-2">
              <RadioGroupItem id={`type-${type}`} value={type} />
              <Label htmlFor={`type-${type}`}>{label}</Label>
            </div>
          ))}
        </RadioGroup>
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
          <Button type="button" disabled={!choice || pending} onClick={() => void confirm()}>
            Change type and extract again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
