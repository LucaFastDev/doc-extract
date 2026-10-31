'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeftIcon } from 'lucide-react'
import type { DocType } from '@shared/doctypes/index'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { formatTime, isDocType } from '@/lib/documents/review'
import { DOC_TYPE_LABELS } from '@/lib/documents/upload'
import { loadApproved, loadExportInput, type ApprovedDocument } from '@/lib/export/load'
import { exportFileName, type ExportFormat } from '@/lib/export/model'
import { createClient } from '@/lib/supabase/client'

const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'xlsx', label: 'XLSX', hint: 'one file with the sheets Documents and Line items' },
  { value: 'csv', label: 'CSV', hint: 'a zip of documents.csv and line_items.csv' },
]

const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'application/zip' }

/** Hands the bytes to the browser as a download under the given name. */
function save(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function Step({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border p-4">
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  )
}

// The export page (PRD US-6.1, OQ-13): the user picks one of the six types, then which of its
// approved documents to export, then XLSX or CSV. The documents are read in the browser as the
// user, through RLS; the file is built here too, by src/lib/export/files.ts, which is loaded only
// when Download is pressed, so its libraries reach no other page.
export function ExportView({ workspace }: { workspace: { id: string; name: string } }) {
  const supabase = useMemo(() => createClient(), [])
  const [approved, setApproved] = useState<ApprovedDocument[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [docType, setDocType] = useState<DocType | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<ExportFormat>('xlsx')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadApproved(supabase, workspace.id).then(
      (docs) => {
        if (!cancelled) setApproved(docs)
      },
      (e: unknown) => {
        console.error('The approved documents could not be loaded.', e)
        if (!cancelled) setLoadError(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [supabase, workspace.id])

  const byType = useMemo(() => {
    const groups: Record<string, ApprovedDocument[]> = {}
    for (const type of Object.keys(DOC_TYPE_LABELS)) groups[type] = []
    for (const d of approved ?? []) if (d.doc_type && groups[d.doc_type]) groups[d.doc_type].push(d)
    return groups
  }, [approved])

  const listed = docType ? byType[docType] : []

  function pickType(value: string) {
    if (!isDocType(value)) return
    setDocType(value)
    setTicked(new Set(byType[value].map((d) => d.id)))
    setError(null)
    setNotice(null)
  }

  function tick(id: string, on: boolean) {
    setTicked((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function download() {
    if (!docType || ticked.size === 0) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const ids = listed.filter((d) => ticked.has(d.id)).map((d) => d.id)
      const { input, left } = await loadExportInput(supabase, workspace.id, docType, ids)
      if (input.documents.length === 0) {
        setError('None of the ticked documents is still approved. Reload the page to see the current list.')
        return
      }
      const { buildCsvZip, buildXlsx } = await import('@/lib/export/files')
      const bytes = format === 'xlsx' ? await buildXlsx(input) : buildCsvZip(input)
      save(bytes, exportFileName(docType, format, new Date()), MIME[format])
      if (left > 0) {
        setNotice(
          `${left} of the ticked documents ${left === 1 ? 'is' : 'are'} no longer approved and ${left === 1 ? 'was' : 'were'} left out.`,
        )
      }
    } catch (e) {
      console.error('The export could not be made.', e)
      setError('The export could not be made. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link
          href="/documents"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          <ArrowLeftIcon className="size-4" aria-hidden />
          Documents
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Export</h1>
        <p className="text-sm text-muted-foreground">
          Approved documents of one type in <span className="font-medium text-foreground">{workspace.name}</span>, with
          corrected values where there are any.
        </p>
      </div>

      {loadError ? (
        <p role="alert" className="rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
          The approved documents could not be loaded. Reload the page to try again.
        </p>
      ) : approved === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading approved documents…
        </p>
      ) : (
        <>
          <Step id="export-type" title="Type">
            <RadioGroup aria-labelledby="export-type" value={docType ?? ''} onValueChange={pickType}>
              {Object.entries(DOC_TYPE_LABELS).map(([type, label]) => {
                const count = byType[type].length
                return (
                  <div key={type} className="flex items-center gap-2">
                    <RadioGroupItem id={`export-type-${type}`} value={type} disabled={count === 0} />
                    <Label htmlFor={`export-type-${type}`} className="flex-wrap">
                      {label}{' '}
                      <span className="font-normal text-muted-foreground">{count} approved</span>
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
            {approved.length === 0 && (
              <p className="text-sm text-muted-foreground">No document is approved yet. Approve documents on their review screen.</p>
            )}
          </Step>

          {docType && (
            <Step id="export-documents" title="Documents">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setTicked(new Set(listed.map((d) => d.id)))}>
                  Select all
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setTicked(new Set())}>
                  Select none
                </Button>
              </div>
              <ul className="divide-y rounded-lg border">
                {listed.map((d) => (
                  <li key={d.id} className="flex items-start gap-3 px-3 py-2">
                    <Checkbox
                      id={`export-doc-${d.id}`}
                      className="mt-0.5"
                      checked={ticked.has(d.id)}
                      onCheckedChange={(on) => tick(d.id, on === true)}
                    />
                    <div className="min-w-0 flex-1">
                      <Label htmlFor={`export-doc-${d.id}`} className="leading-snug [overflow-wrap:anywhere]">
                        {d.file_name}
                      </Label>
                      <p className="mt-1 text-xs text-muted-foreground">Approved {formatTime(d.approved_at)}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {ticked.size} of {listed.length} ticked
              </p>
            </Step>
          )}

          <Step id="export-format" title="Format">
            <RadioGroup aria-labelledby="export-format" value={format} onValueChange={(v) => setFormat(v === 'csv' ? 'csv' : 'xlsx')}>
              {FORMATS.map((f) => (
                <div key={f.value} className="flex items-start gap-2">
                  <RadioGroupItem id={`export-format-${f.value}`} value={f.value} className="mt-0.5" />
                  <Label htmlFor={`export-format-${f.value}`} className="flex-wrap leading-snug">
                    {f.label} <span className="font-normal text-muted-foreground">{f.hint}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </Step>

          <div className="flex flex-col gap-3">
            <Button
              type="button"
              className="w-full sm:w-fit"
              disabled={!docType || ticked.size === 0 || busy}
              aria-busy={busy}
              onClick={() => void download()}
            >
              Download
            </Button>
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                Preparing the file…
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
          </div>
        </>
      )}
    </>
  )
}
