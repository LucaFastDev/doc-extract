import { parseDecimal } from '../shared/doctypes/decimal.ts'
import type { DocType } from '../shared/doctypes/index.ts'
import type { FieldKind, FieldRow } from '../shared/doctypes/fields.ts'

// The eval's scoring (PRD F16 AC-5 and section 10, issue #43 criterion 3 and Lead rulings 3 and 4).
// For a document type, header fields and line-item cells apart: the share of expected values the
// extraction returns exactly, after normalisation. Pure: the runner (run.ts) gives it the expected
// results in eval/expected/ and what the app's own validation made of Claude's answer.

/** One field or line-item cell as the app stores it: path as in extraction_fields, null when not printed. */
export interface ExpectedField {
  path: string
  kind: FieldKind
  value: string | null
}

/** A file in eval/expected/: every field and line-item cell of the document's type. */
export interface ExpectedResult {
  /** The file name in eval/documents/. */
  document: string
  doc_type: DocType
  fields: ExpectedField[]
}

/** What became of one document: the app's validated rows, Not supported, or a failure after retries. */
export type Extraction =
  | { outcome: 'ok'; doc_type: DocType; fields: FieldRow[] }
  | { outcome: 'not_supported'; reason: string }
  | { outcome: 'failed'; error: string }

/** The targets of PRD section 10 (OQ-32): shown beside the accuracy, never a release blocker. */
export const TARGETS: Record<DocType, { header: number; line_items: number }> = {
  invoice: { header: 0.95, line_items: 0.9 },
  receipt: { header: 0.92, line_items: 0.85 },
  bank_statement: { header: 0.95, line_items: 0.95 },
  purchase_order: { header: 0.95, line_items: 0.9 },
  delivery_note: { header: 0.95, line_items: 0.9 },
  quote: { header: 0.95, line_items: 0.9 },
}

/**
 * Each type's totals and subtotals, for check usefulness (PRD section 10): a misread of one of
 * these should be flagged by an arithmetic check. A delivery note's total is its total quantity; a
 * bank statement's are its closing balance and its totals in and out.
 */
export const TOTALS: Record<DocType, string[]> = {
  invoice: ['subtotal', 'total'],
  receipt: ['subtotal', 'total'],
  bank_statement: ['closing_balance', 'total_credits', 'total_debits'],
  purchase_order: ['subtotal', 'total'],
  delivery_note: ['total_quantity'],
  quote: ['subtotal', 'total'],
}

/** A miss at or above this confidence is a confident miss (Lead ruling 4; app_config.confidence_threshold). */
export const CONFIDENT = 0.8

const DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/

/**
 * A value as it is compared: null when empty; a date as YYYY-MM-DD; an amount, number or
 * percentage as its exact decimal without leading or trailing zeros (18.90 and 18.9 are equal);
 * text, and anything that does not read as its kind, lower cased and trimmed.
 */
export function normalise(kind: FieldKind, value: string | null | undefined): string | null {
  const s = (value ?? '').trim()
  if (s === '') return null
  if (kind === 'date') {
    const m = DATE.exec(s)
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }
  if (kind === 'amount' || kind === 'number' || kind === 'percent') {
    const d = parseDecimal(s.replace(/^\+/, ''))
    if (d) {
      const negative = d.units < 0n
      const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, '0')
      const whole = digits.slice(0, digits.length - d.scale).replace(/^0+(?=\d)/, '')
      const fraction = digits.slice(digits.length - d.scale).replace(/0+$/, '')
      const text = fraction ? `${whole}.${fraction}` : whole
      return negative && text !== '0' ? `-${text}` : text
    }
  }
  return s.toLowerCase()
}

export interface Miss {
  path: string
  expected: string | null
  /** What the app stored, or null when it stored nothing there. */
  got: string | null
  /** Claude's confidence in what it returned; null when it returned no such field. */
  confidence: number | null
}

export interface Tally {
  correct: number
  total: number
}

export interface DocumentScore {
  document: string
  doc_type: DocType
  outcome: Extraction['outcome']
  /** The type Claude's tool call recorded, 'not_supported', or null for a failed document. */
  detected_type: DocType | 'not_supported' | null
  type_correct: boolean
  error?: string
  header: Tally
  line_items: Tally
  misses: Miss[]
  /** Misses whose confidence was at or above CONFIDENT. */
  confident_misses: number
  /** Claude's confidence for every field and cell it returned, by path (ruling 4: recorded, not scored). */
  confidence: Record<string, number>
  /** Rows beyond the expected ones: listed, not scored (ruling 3). */
  extra_line_items: { index: number; values: Record<string, string | null> }[]
}

const LINE = /^line_items\[(\d+)\]\.(.+)$/

/** Scores one document against its expected result (rulings 3 and 4). */
export function scoreDocument(expected: ExpectedResult, extraction: Extraction): DocumentScore {
  const detected = extraction.outcome === 'ok' ? extraction.doc_type : extraction.outcome === 'not_supported' ? 'not_supported' : null
  const typeCorrect = detected === expected.doc_type
  const rows = extraction.outcome === 'ok' && typeCorrect ? extraction.fields : []
  const byPath = new Map(rows.map((r) => [r.path, r]))
  const extractedLines = new Set(rows.map((r) => LINE.exec(r.path)?.[1]).filter((i) => i !== undefined).map(Number))
  const expectedLines = new Set(expected.fields.map((f) => LINE.exec(f.path)?.[1]).filter((i) => i !== undefined).map(Number))

  const header: Tally = { correct: 0, total: 0 }
  const lineItems: Tally = { correct: 0, total: 0 }
  const misses: Miss[] = []
  for (const f of expected.fields) {
    const line = LINE.exec(f.path)
    const tally = line ? lineItems : header
    tally.total += 1
    const row = byPath.get(f.path)
    // A cell of a row the extraction does not have is a miss, even an empty one (ruling 3).
    const present = typeCorrect && (!line || extractedLines.has(Number(line[1])))
    if (present && normalise(f.kind, row?.extracted_value) === normalise(f.kind, f.value)) {
      tally.correct += 1
    } else {
      misses.push({ path: f.path, expected: f.value, got: row?.extracted_value ?? null, confidence: row?.confidence ?? null })
    }
  }

  const extra = new Map<number, Record<string, string | null>>()
  for (const r of rows) {
    const line = LINE.exec(r.path)
    if (!line || expectedLines.has(Number(line[1]))) continue
    const index = Number(line[1])
    extra.set(index, { ...extra.get(index), [line[2]]: r.extracted_value })
  }

  return {
    document: expected.document,
    doc_type: expected.doc_type,
    outcome: extraction.outcome,
    detected_type: detected,
    type_correct: typeCorrect,
    ...(extraction.outcome === 'failed' ? { error: extraction.error } : {}),
    header,
    line_items: lineItems,
    misses,
    confident_misses: misses.filter((m) => m.confidence !== null && m.confidence >= CONFIDENT).length,
    confidence: Object.fromEntries(extraction.outcome === 'ok' ? extraction.fields.map((r) => [r.path, r.confidence]) : []),
    extra_line_items: [...extra.entries()].sort(([a], [b]) => a - b).map(([index, values]) => ({ index, values })),
  }
}

export interface Accuracy extends Tally {
  /** correct / total, or null when the type has no such values. */
  accuracy: number | null
  target: number
  meets_target: boolean | null
}

export interface TypeScore {
  documents: number
  header: Accuracy
  line_items: Accuracy
  type_detection: Tally
}

function accuracy(t: Tally, target: number): Accuracy {
  const value = t.total === 0 ? null : t.correct / t.total
  return { ...t, accuracy: value, target, meets_target: value === null ? null : value >= target }
}

/** Each type's accuracy over its documents, beside the PRD's targets; types with no document are left out. */
export function scoreRun(documents: DocumentScore[]): Partial<Record<DocType, TypeScore>> {
  const out: Partial<Record<DocType, TypeScore>> = {}
  for (const type of Object.keys(TARGETS) as DocType[]) {
    const docs = documents.filter((d) => d.doc_type === type)
    if (docs.length === 0) continue
    const add = (pick: (d: DocumentScore) => Tally): Tally =>
      docs.reduce((t, d) => ({ correct: t.correct + pick(d).correct, total: t.total + pick(d).total }), { correct: 0, total: 0 })
    out[type] = {
      documents: docs.length,
      header: accuracy(add((d) => d.header), TARGETS[type].header),
      line_items: accuracy(add((d) => d.line_items), TARGETS[type].line_items),
      type_detection: { correct: docs.filter((d) => d.type_correct).length, total: docs.length },
    }
  }
  return out
}
