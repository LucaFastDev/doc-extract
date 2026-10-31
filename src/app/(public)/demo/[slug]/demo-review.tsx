'use client'

import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { demoExportInput, demoReviewData, type DemoSample } from '@/lib/demo/sample'
import type { ReviewRow } from '@/lib/documents/review'
import { FORMATS, MIME, save } from '@/lib/export/download'
import { exportFileName, type ExportFormat } from '@/lib/export/model'
import { ReviewScreen } from '../../../(app)/documents/[id]/review-screen'

// A sample on the review screen in demo mode (PRD F13 AC-5, Lead ruling 3 on #41): edits stay in
// this tab's memory, and the checks are re-run on them in the browser with the tolerance the stored
// result was checked with.
export function DemoReview({ sample }: { sample: DemoSample }) {
  const [initial] = useState(() => demoReviewData(sample))
  return (
    <ReviewScreen
      initial={initial}
      amountTolerance={sample.result.amount_tolerance}
      demo={{ renderExport: (rows) => <DemoExport sample={sample} rows={rows} /> }}
    />
  )
}

/**
 * Export with XLSX or CSV, as the export page builds them (F13 AC-5, Lead ruling 4 on #41): from
 * the sample as currently edited, by files.ts, loaded only when Download is pressed.
 */
function DemoExport({ sample, rows }: { sample: DemoSample; rows: ReviewRow[] }) {
  const id = useId()
  const [format, setFormat] = useState<ExportFormat>('xlsx')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setBusy(true)
    setError(null)
    try {
      const input = demoExportInput(sample, rows)
      const { buildCsvZip, buildXlsx } = await import('@/lib/export/files')
      const bytes = format === 'xlsx' ? await buildXlsx(input) : buildCsvZip(input)
      save(bytes, exportFileName(input.docType, format, new Date()), MIME[format])
    } catch (e) {
      console.error('The export could not be made.', e)
      setError('The export could not be made. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        Export
      </h2>
      <p className="text-sm text-muted-foreground">The sample with your corrections, as an approved document would be exported.</p>
      <RadioGroup aria-labelledby={id} value={format} onValueChange={(v) => setFormat(v === 'csv' ? 'csv' : 'xlsx')}>
        {FORMATS.map((f) => (
          <div key={f.value} className="flex items-start gap-2">
            <RadioGroupItem id={`${id}-${f.value}`} value={f.value} className="mt-0.5" />
            <Label htmlFor={`${id}-${f.value}`} className="flex-wrap leading-snug">
              {f.label} <span className="font-normal text-muted-foreground">{f.hint}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
      <Button type="button" className="w-full sm:w-fit" disabled={busy} aria-busy={busy} onClick={() => void download()}>
        Download
      </Button>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
