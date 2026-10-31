import type { DocTypeDef } from '@shared/doctypes/doctype'
import { LAST4_FIELDS, lastFour, type CheckResult, type FieldDef } from '@shared/doctypes/fields'
import { DOC_TYPES, type DocType } from '@shared/doctypes/index'
import { currentValue, parseLinePath, recheck, type StoredField } from '@shared/doctypes/review'

// The review screen's model (PRD F5, US-4.1 AC-7, OQ-44): corrections, line items added and
// deleted as add_line_item and delete_line_item do them, the checks re-run in the browser on
// every saved edit, the flags they give, and the order fields are listed in, flagged first.

export type ReviewRow = StoredField

export const isDocType = (t: string | null): t is DocType => t !== null && t in DOC_TYPES

// Corrections ---------------------------------------------------------------------------------

const LAST4 = new Set<string>(LAST4_FIELDS)

/**
 * The corrected_value to store for what the user typed: null when it is the extracted value again,
 * so the field shows as uncorrected; a card, account or IBAN number cut to its last four (OQ-29).
 */
export function correctionFor(row: Pick<ReviewRow, 'path' | 'extracted_value'>, typed: string): string | null {
  const name = parseLinePath(row.path)?.name ?? row.path
  const trimmed = typed.trim()
  const value = LAST4.has(name) && trimmed !== '' ? lastFour(trimmed) : trimmed
  return value === (row.extracted_value ?? '').trim() ? null : value
}

/**
 * What the screen says when a correction was not stored (Lead ruling on QA pass 2 of #34): that the
 * document no longer needs review only when its status, read after the failure, says so; any other
 * failure, a network error or a status that could not be read, asks the user to try again.
 */
export function saveFailure(label: string, status: string | null): string {
  return status !== null && status !== 'needs_review'
    ? `${label} could not be saved: the document no longer needs review.`
    : `${label} could not be saved. Try again.`
}

/** The rows with one field's correction set; the extracted value is kept. */
export function applyCorrection(rows: ReviewRow[], path: string, corrected: string | null): ReviewRow[] {
  return rows.map((r) => (r.path === path ? { ...r, corrected_value: corrected } : r))
}

/** How many lines the rows hold: one more than the highest line_items[i]. */
export function lineCount(rows: ReviewRow[]): number {
  return rows.reduce((n, r) => Math.max(n, (parseLinePath(r.path)?.index ?? -1) + 1), 0)
}

function moveLines(rows: ReviewRow[], after: number, delta: number): ReviewRow[] {
  return rows.map((r) => {
    const line = parseLinePath(r.path)
    return line && line.index > after ? { ...r, path: `line_items[${line.index + delta}].${line.name}` } : r
  })
}

/** An empty line after line `after` (-1 for the first), the later lines moved down, as add_line_item. */
export function addLine(rows: ReviewRow[], lineFields: FieldDef[], after: number): ReviewRow[] {
  const at = after + 1
  const added: ReviewRow[] = lineFields.map((f) => ({
    path: `line_items[${at}].${f.name}`,
    kind: f.kind,
    extracted_value: null,
    corrected_value: null,
    confidence: null,
    flags: [],
  }))
  return [...moveLines(rows, after, 1), ...added]
}

/** The rows without line `index`, the later lines moved up, as delete_line_item. */
export function deleteLine(rows: ReviewRow[], index: number): ReviewRow[] {
  return moveLines(
    rows.filter((r) => parseLinePath(r.path)?.index !== index),
    index,
    -1,
  )
}

// Checks and flags ------------------------------------------------------------------------------

export interface Review {
  checks: CheckResult[]
  /** Each row's flags: low_confidence, check_failed, duplicate, currency_guessed. */
  flags: Record<string, string[]>
}

/**
 * The checks on the current values, as the server will run them at approval. U1 needs the
 * database, so it keeps its stored result, and its duplicate flags, until then (Lead ruling 2 on
 * #32).
 */
export function liveReview(def: DocTypeDef, rows: ReviewRow[], stored: CheckResult[], context: { amountTolerance: string; today: string }): Review {
  const live = recheck(def, rows, context)
  const storedU1 = stored.find((c) => c.check_id === 'U1')
  const checks = live.checks.map((c) => (c.check_id === 'U1' && storedU1 ? storedU1 : c))
  const flags: Record<string, string[]> = {}
  for (const row of rows) {
    const f = [...(live.flags[row.path] ?? [])]
    if (row.flags.includes('duplicate')) f.push('duplicate')
    flags[row.path] = f
  }
  return { checks, flags }
}

/** The stored result, for an approved document, which is no longer edited. */
export function storedReview(rows: ReviewRow[], stored: CheckResult[]): Review {
  return { checks: stored, flags: Object.fromEntries(rows.map((r) => [r.path, r.flags])) }
}

/** The failed checks that have no tick: while there is one, the document cannot be approved (OQ-11). */
export function untickedFailures(checks: CheckResult[], ticked: Set<string>): string[] {
  return checks.filter((c) => c.status === 'fail' && !ticked.has(c.check_id)).map((c) => c.check_id)
}

/** The flags in the order US-5.1 AC-2 names them, which is also the order the screen lists them in. */
export const FLAG_ORDER = ['check_failed', 'low_confidence', 'duplicate', 'currency_guessed'] as const

/** Why a row is flagged, one line per flag. */
export function flagReasons(row: ReviewRow, flags: string[], checks: CheckResult[], rows: ReviewRow[]): string[] {
  const reasons: string[] = []
  for (const flag of FLAG_ORDER) {
    if (!flags.includes(flag)) continue
    if (flag === 'check_failed' || flag === 'duplicate') {
      for (const c of checks) {
        const isU1 = c.check_id === 'U1'
        if (c.status === 'fail' && c.field_paths.includes(row.path) && (flag === 'duplicate') === isU1) {
          reasons.push(`${c.check_id}: ${c.message ?? 'failed'}`)
        }
      }
    } else if (flag === 'low_confidence') {
      reasons.push(`Low confidence${row.confidence === null ? '' : ` (${formatConfidence(row.confidence)})`}`)
    } else {
      const printed = currentValue(rows.find((r) => r.path === 'currency_as_printed') ?? { extracted_value: null, corrected_value: null })?.trim()
      reasons.push(
        printed
          ? `Currency guessed: only “${printed}” is printed, which several currencies use`
          : 'Currency guessed: no currency is printed',
      )
    }
  }
  return reasons
}

export function formatConfidence(confidence: number | null): string {
  return confidence === null ? '—' : `${Math.round(confidence * 100)}%`
}

// Order -----------------------------------------------------------------------------------------

export interface FieldGroups {
  /** Every flagged field and cell, most serious flag first, then in the type's order. */
  flagged: ReviewRow[]
  /** The header fields with no flag, in the type's order. */
  fields: ReviewRow[]
  /** Each line's cells with no flag, in the type's order; every line is listed. */
  lines: ReviewRow[][]
}

/** Header fields in def.fields order, then each line's cells in def.lineFields order. */
function typeOrder(def: DocTypeDef, row: ReviewRow): number {
  const line = parseLinePath(row.path)
  if (!line) {
    const i = def.fields.findIndex((f) => f.name === row.path)
    return i < 0 ? def.fields.length : i
  }
  const j = def.lineFields.findIndex((f) => f.name === line.name)
  return (def.fields.length + 1) * 1000 + line.index * 100 + (j < 0 ? 99 : j)
}

/** Flagged first (US-5.1 AC-2), then the rest: each field and cell is listed once. */
export function groupFields(def: DocTypeDef, rows: ReviewRow[], flags: Record<string, string[]>): FieldGroups {
  const severity = (r: ReviewRow) => {
    const f = flags[r.path] ?? []
    const i = FLAG_ORDER.findIndex((flag) => f.includes(flag))
    return i < 0 ? FLAG_ORDER.length : i
  }
  const ordered = [...rows].sort((a, b) => typeOrder(def, a) - typeOrder(def, b))
  const flagged = ordered.filter((r) => severity(r) < FLAG_ORDER.length).sort((a, b) => severity(a) - severity(b))
  const rest = ordered.filter((r) => severity(r) === FLAG_ORDER.length)
  const lines: ReviewRow[][] = Array.from({ length: lineCount(rows) }, () => [])
  for (const r of rest) {
    const line = parseLinePath(r.path)
    if (line) lines[line.index].push(r)
  }
  return { flagged, fields: rest.filter((r) => !parseLinePath(r.path)), lines }
}

// Labels ----------------------------------------------------------------------------------------

const WORDS: Record<string, string> = { id: 'ID', iban: 'IBAN', vat: 'VAT', po: 'PO' }

/** A field name for people: vendor_tax_id is "Vendor tax ID", card_last4 is "Card (last 4)". */
export function fieldName(name: string): string {
  const base = name.endsWith('_last4') ? name.slice(0, -'_last4'.length) : name
  const words = base.split('_').map((w) => WORDS[w] ?? w)
  const text = words.join(' ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${base === name ? '' : ' (last 4)'}`
}

/** "Line" or, for a bank statement, "Transaction". */
export function lineWord(def: DocTypeDef): string {
  return def.linesKey === 'transactions' ? 'Transaction' : 'Line'
}

const TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** "31 Oct 2026, 14:05 UTC": the same on the server and in every browser, whatever its time zone. */
export function formatTime(iso: string): string {
  return `${TIME.format(new Date(iso))} UTC`
}

/** What each kind of history entry is called (US-5.1 AC-7). */
export const EVENT_LABELS: Record<string, string> = {
  uploaded: 'Uploaded',
  extracted: 'Extracted',
  approved: 'Approved',
  reopened: 'Reopened',
  type_changed: 'Type changed',
  retried: 'Retried',
}

/** Who a history entry names: the member, Claude for an extraction, or a deleted account. */
export function eventActor(event: { kind: string; actor: string | null }, people: Record<string, string>): string {
  if (event.kind === 'extracted') return 'Claude'
  return event.actor ? (people[event.actor] ?? 'a member') : 'a deleted user'
}

/** A field's label: "Subtotal", or "Line 2 · Amount" for a cell. */
export function fieldLabel(def: DocTypeDef, path: string): string {
  const line = parseLinePath(path)
  return line ? `${lineWord(def)} ${line.index + 1} · ${fieldName(line.name)}` : fieldName(path)
}
