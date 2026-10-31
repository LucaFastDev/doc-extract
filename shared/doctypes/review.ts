import { currencyGuessed } from './currency.ts'
import type { DocTypeDef } from './doctype.ts'
import type { DuplicateKey } from './duplicate.ts'
import { amountTolerance, LAST4_FIELDS, lastFour, type CheckResult, type DocumentValues, type FieldKind } from './fields.ts'

// The checks again, on a document's corrected values (PRD US-4.1 AC-7, US-5.1 AC-5, OQ-44): the
// review screen runs this in the browser after each edit, and approve-document runs it before it
// approves (ARCHITECTURE.md section 6.1). Both read the same extraction_fields rows.

/** One extraction_fields row as the review screen and approve-document read it. */
export interface StoredField {
  path: string
  kind: FieldKind
  extracted_value: string | null
  corrected_value: string | null
  /** null for a cell of a line the user added. */
  confidence: number | null
  flags: string[]
}

const LINE_PATH = /^line_items\[(\d+)\]\.(.+)$/

/** A path's line index and cell name, or null for a header field. */
export function parseLinePath(path: string): { index: number; name: string } | null {
  const m = LINE_PATH.exec(path)
  return m ? { index: Number(m[1]), name: m[2] } : null
}

/** The value the checks read: the correction if there is one, else the extracted value. */
export function currentValue(row: Pick<StoredField, 'extracted_value' | 'corrected_value'>): string | null {
  return row.corrected_value ?? row.extracted_value
}

const LAST4 = new Set<string>(LAST4_FIELDS)

/** As prepareResult normalises a value: trimmed, blank as null, a last-four field cut (OQ-29). */
function normalise(name: string, value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return null
  return LAST4.has(name) ? lastFour(trimmed) : trimmed
}

/** The document's values by field and by line, as the type's checks read them. */
export function documentValues(def: DocTypeDef, rows: StoredField[]): DocumentValues {
  const fields: DocumentValues['fields'] = Object.fromEntries(def.fields.map((f) => [f.name, null]))
  const lines: Record<string, string | null>[] = []
  const emptyLine = () => Object.fromEntries(def.lineFields.map((f) => [f.name, null]))
  for (const row of rows) {
    const line = parseLinePath(row.path)
    if (line) {
      while (lines.length <= line.index) lines.push(emptyLine())
      lines[line.index][line.name] = normalise(line.name, currentValue(row))
    } else {
      fields[row.path] = normalise(row.path, currentValue(row))
    }
  }
  return { fields, line_items: lines }
}

export interface RecheckContext {
  /** app_config.amount_tolerance, as a decimal string (OQ-7). */
  amountTolerance: string
  /** Today's date in UTC, YYYY-MM-DD (OQ-6). */
  today: string
}

export interface Recheck {
  /** Every check of the type, U1 as it stands with no earlier document (duplicate.ts). */
  checks: CheckResult[]
  /** Each row's flags but duplicate, which only U1 against the database sets. */
  flags: Record<string, string[]>
  duplicate: DuplicateKey
}

/**
 * Runs the type's checks on the current values and flags each row as prepareResult does:
 * low_confidence as extracted (a correction does not change Claude's confidence), check_failed
 * where a failed check names the row, currency_guessed on the currency while the printed currency
 * names no one currency (OQ-16).
 */
export function recheck(def: DocTypeDef, rows: StoredField[], context: RecheckContext): Recheck {
  const values = documentValues(def, rows)
  const checks = def.checks(values, {
    tolerance: amountTolerance(values.fields.currency ?? null, context.amountTolerance),
    today: context.today,
  })
  const failed = new Set(checks.filter((c) => c.status === 'fail').flatMap((c) => c.field_paths))
  const guessed = def.flagsCurrency && currencyGuessed(values.fields.currency_as_printed)
  const flags: Record<string, string[]> = {}
  for (const row of rows) {
    const f: string[] = []
    if (row.flags.includes('low_confidence')) f.push('low_confidence')
    if (failed.has(row.path)) f.push('check_failed')
    if (guessed && row.path === 'currency') f.push('currency_guessed')
    flags[row.path] = f
  }
  return { checks, flags, duplicate: def.duplicateKey(values) }
}
