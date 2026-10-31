import { readdirSync, readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { utcDate } from '@shared/doctypes/checks'
import { checkU1 } from '@shared/doctypes/duplicate'
import { LAST4_FIELDS } from '@shared/doctypes/fields'
import { DOC_TYPES } from '@shared/doctypes/index'
import { documentValues, recheck } from '@shared/doctypes/review'
import { applyCorrection, liveReview } from '@/lib/documents/review'
import { demoReviewData, type DemoResult, type DemoSample } from '@/lib/demo/sample'
import { buildSamples, receiptLines } from './make-samples'
import { SAMPLES, SAMPLES_DIR, type SampleValues } from './samples'

// The demo samples (issue #41 criteria 1 to 4): the committed files are what the generator makes;
// the migration's rows hold, for each, the values the document prints, low_confidence below the
// 0.8 threshold, and the checks and flags the shared checks give, as the browser re-runs them; and
// together the samples show every kind of flag (OQ-38).

const MIGRATION = new URL('../supabase/migrations/20261031193713_demo.sql', import.meta.url)
const THRESHOLD = 0.8

interface Row {
  slug: string
  doc_type: string
  title: string
  summary: string
  file_path: string
  page_count: number
  sort_order: number
  published: boolean
  result: DemoResult
}

const unquote = (s: string) => s.replaceAll("''", "'")

/** The rows the migration inserts, read from its text. */
function migrationRows(): Row[] {
  const sql = readFileSync(MIGRATION, 'utf8')
  const row =
    /\('([^']*)', '([^']*)', '((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'([^']*)', (\d+), (\d+), (true|false), \$result\$([\s\S]*?)\$result\$::jsonb\)/g
  return [...sql.matchAll(row)].map((m) => ({
    slug: m[1],
    doc_type: m[2],
    title: unquote(m[3]),
    summary: unquote(m[4]),
    file_path: m[5],
    page_count: Number(m[6]),
    sort_order: Number(m[7]),
    published: m[8] === 'true',
    result: JSON.parse(m[9]) as DemoResult,
  }))
}

const rows = migrationRows()
const rowOf = (s: SampleValues) => rows.find((r) => r.file_path === s.file)!
const sampleOf = (r: Row): DemoSample => ({ ...r, id: `id-${r.slug}`, doc_type: r.result.doc_type })
const today = utcDate(new Date())

/** Every text item of every page of a PDF, one per line. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise
  const pages: string[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    pages.push(content.items.map((i) => ('str' in i ? i.str : '')).join('\n'))
  }
  await pdf.destroy()
  return pages.join('\n')
}

describe('the sample files', () => {
  it('are what the generator makes, byte for byte, and nothing else', async () => {
    const built = await buildSamples()
    expect(readdirSync(SAMPLES_DIR).sort()).toEqual([...built.keys()].sort())
    for (const [name, bytes] of built) {
      expect(new Uint8Array(readFileSync(new URL(name, SAMPLES_DIR))), name).toEqual(bytes)
    }
  })

  it('are one per type and a second invoice; the receipt is a PNG, the rest PDFs, one of them of two pages or more', async () => {
    expect(SAMPLES.map((s) => s.docType).sort()).toEqual(
      ['bank_statement', 'delivery_note', 'invoice', 'invoice', 'purchase_order', 'quote', 'receipt'].sort(),
    )
    for (const s of SAMPLES) expect(s.file.endsWith(s.docType === 'receipt' ? '.png' : '.pdf'), s.file).toBe(true)
    const pages = await Promise.all(
      SAMPLES.filter((s) => s.file.endsWith('.pdf')).map(async (s) => (await PDFDocument.load(readFileSync(new URL(s.file, SAMPLES_DIR)))).getPageCount()),
    )
    expect(Math.max(...pages)).toBeGreaterThanOrEqual(2)
  })

  it('print every value their results hold', async () => {
    for (const s of SAMPLES) {
      const text = s.file.endsWith('.pdf')
        ? await pdfText(new Uint8Array(readFileSync(new URL(s.file, SAMPLES_DIR))))
        : receiptLines()
            .map((l) => l.text.trim())
            .join(' ')
      const printed = [...Object.entries(s.fields), ...s.lines.flatMap((l) => Object.entries(l))].filter(
        // The language and the currency code are read from the document, not printed on it.
        ([name, value]) => value !== '' && name !== 'language' && name !== 'currency',
      )
      for (const [name, value] of printed) expect(text, `${s.file}: ${name}`).toContain(value)
    }
  })
})

describe('the migration’s rows', () => {
  it('are the seven samples, published, in order, each named {slug}.{ext} with its page count', async () => {
    expect(rows.map((r) => r.file_path)).toEqual(SAMPLES.map((s) => s.file))
    expect(rows.map((r) => r.sort_order)).toEqual([1, 2, 3, 4, 5, 6, 7])
    for (const r of rows) {
      expect(r.published).toBe(true)
      expect(r.file_path).toMatch(new RegExp(`^${r.slug}\\.(pdf|png)$`))
      expect(r.result.doc_type).toBe(r.doc_type)
      expect(r.title).not.toBe('')
      expect(r.summary).not.toBe('')
      const bytes = readFileSync(new URL(r.file_path, SAMPLES_DIR))
      const pages = r.file_path.endsWith('.pdf') ? (await PDFDocument.load(bytes)).getPageCount() : 1
      expect(r.page_count, r.file_path).toBe(pages)
    }
  })

  it('hold every field and cell of the type, with the value the document prints', () => {
    for (const s of SAMPLES) {
      const { result } = rowOf(s)
      const def = DOC_TYPES[s.docType]
      const expected = [
        ...def.fields.map((f) => ({ path: f.name, kind: f.kind, value: s.fields[f.name] })),
        ...s.lines.flatMap((l, i) => def.lineFields.map((f) => ({ path: `line_items[${i}].${f.name}`, kind: f.kind, value: l[f.name] }))),
      ]
      // A field that is not printed is stored as null, and a card or account number as its last four (OQ-29).
      const stored = (name: string, value: string) =>
        value === '' ? null : (LAST4_FIELDS as readonly string[]).includes(name) ? value.replace(/\s/g, '').slice(-4) : value
      expect(
        result.fields.map((f) => ({ path: f.path, kind: f.kind, value: f.extracted_value })),
        s.file,
      ).toEqual(expected.map((e) => ({ ...e, value: stored(e.path.replace(/^line_items\[\d+\]\./, ''), e.value) })))
    }
  })

  it('flag low confidence exactly where the confidence is below 0.8', () => {
    for (const r of rows) {
      for (const f of r.result.fields) {
        expect(f.confidence, f.path).toBeGreaterThanOrEqual(0)
        expect(f.confidence, f.path).toBeLessThanOrEqual(1)
        expect(f.flags.includes('low_confidence'), `${r.file_path} ${f.path}`).toBe(f.confidence < THRESHOLD)
      }
    }
  })

  it('hold the checks and flags the browser gives when it re-runs the checks, the duplicate’s U1 as stored against the first invoice', () => {
    const first = rowOf(SAMPLES[0])
    for (const r of rows) {
      const def = DOC_TYPES[r.result.doc_type]
      const data = demoReviewData(sampleOf(r))
      const context = { amountTolerance: r.result.amount_tolerance, today }
      const live = liveReview(def, data.fields, data.checks, context)
      const fresh = recheck(def, data.fields, context).checks
      const u1 = r.file_path === 'invoice-duplicate.pdf'
        ? checkU1(def.duplicateKey(documentValues(def, data.fields)), { file_name: first.file_path, by: 'key' })
        : fresh.find((c) => c.check_id === 'U1')
      expect(r.result.amount_tolerance).toBe('0.01')
      expect(r.result.checks, r.file_path).toEqual(fresh.map((c) => (c.check_id === 'U1' ? u1 : c)))
      expect(live.checks, r.file_path).toEqual(r.result.checks)
      for (const f of r.result.fields) expect(live.flags[f.path], `${r.file_path} ${f.path}`).toEqual(f.flags)
    }
  })

  it('show every kind of flag between them: a failed arithmetic check, a date flag, low confidence and a duplicate', () => {
    const failed = rows.flatMap((r) => r.result.checks.filter((c) => c.status === 'fail').map((c) => c.check_id))
    expect(failed.some((id) => id.startsWith('A'))).toBe(true)
    expect(failed.some((id) => id.startsWith('D'))).toBe(true)
    expect(failed).toContain('U1')
    const flags = rows.flatMap((r) => r.result.fields.flatMap((f) => f.flags))
    expect(flags).toEqual(expect.arrayContaining(['check_failed', 'low_confidence', 'duplicate']))
  })

  it('let a visitor correct the wrong total so its check passes', () => {
    const r = rowOf(SAMPLES[0])
    const def = DOC_TYPES.invoice
    const data = demoReviewData(sampleOf(r))
    const context = { amountTolerance: r.result.amount_tolerance, today }
    expect(liveReview(def, data.fields, data.checks, context).checks.find((c) => c.check_id === 'A3')?.status).toBe('fail')
    const corrected = applyCorrection(data.fields, 'total', '303.43')
    const after = liveReview(def, corrected, data.checks, context)
    expect(after.checks.find((c) => c.check_id === 'A3')?.status).toBe('pass')
    expect(after.flags.total).toEqual([])
  })
})
