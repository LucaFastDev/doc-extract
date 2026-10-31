import { parseDecimal } from './decimal.ts'
import { parseDate } from './checks.ts'
import type { CheckResult, DocumentValues } from './fields.ts'

// Duplicate detection, check U1 of every type (PRD section 4.3, OQ-9, Lead rulings 1 to 3 on #27).
// A type's U1 key is a few of its fields; the key is the type name and those fields normalised,
// stored as documents.duplicate_key. record_extraction looks for an earlier document of the
// workspace with the same file (sha256) or the same key, in the transaction that stores the
// result, and turns the U1 row built here into a failure when it finds one.

/** A field of a U1 key, and how it is normalised. */
export interface KeyField {
  name: string
  kind: 'text' | 'date' | 'amount'
}

export interface DuplicateKey {
  /** documents.duplicate_key; null when any key field is empty. */
  key: string | null
  /** The fields the key reads, as U1 reports them. */
  field_paths: string[]
  /** Those of them with a value: the fields a duplicate flags (Lead ruling 3). */
  flag_paths: string[]
  /** What the key is, for messages: "vendor and invoice number". */
  label: string
}

/** Lower case, then no whitespace or punctuation (Lead ruling 1). */
export function normaliseText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}]/gu, '')
}

/**
 * A key part. Text and dates as normaliseText; an amount as its exact decimal without trailing
 * zeros and with its point kept, so 12.50 and 12.5 match and 1250 and 12.50 do not.
 */
export function normalisePart(value: string, kind: KeyField['kind']): string {
  if (kind === 'amount') {
    const d = parseDecimal(value)
    if (d) {
      const text = value.trim().replace(/^(-?)0+(?=\d)/, '$1')
      return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
    }
  }
  if (kind === 'date') {
    const date = parseDate(value)
    if (date) return date.replace(/-/g, '')
  }
  return normaliseText(value)
}

/** The key of a document whose U1 reads these fields. */
export function duplicateKey(docType: string, v: DocumentValues, fields: KeyField[], label: string): DuplicateKey {
  const parts = fields.map((f) => normalisePart(v.fields[f.name] ?? '', f.kind))
  return {
    key: parts.every((p) => p !== '') ? [docType, ...parts].join('|') : null,
    field_paths: fields.map((f) => f.name),
    flag_paths: fields.filter((f, i) => parts[i] !== '').map((f) => f.name),
    label,
  }
}

/** The earlier document a duplicate matches, and whether its file or its key matched. */
export interface DuplicateMatch {
  file_name: string
  by: 'file' | 'key'
}

/**
 * U1. With no match, it passes when the key is complete and is skipped when it is not; with a
 * match it fails, naming the earlier file and what matched, and names the key fields that have a
 * value. record_extraction builds the same failure in SQL (tests/access/duplicates.test.ts).
 */
export function checkU1(key: DuplicateKey, match: DuplicateMatch | null): CheckResult {
  if (match) {
    const what = match.by === 'file' ? 'the same file was uploaded before' : `the same ${key.label}`
    return { check_id: 'U1', status: 'fail', field_paths: key.flag_paths, message: `Duplicate of "${match.file_name}": ${what}.` }
  }
  if (key.key === null) {
    return {
      check_id: 'U1',
      status: 'skipped',
      field_paths: key.field_paths,
      message: `Skipped: the ${key.label} are not all printed, and no earlier upload is the same file.`,
    }
  }
  return { check_id: 'U1', status: 'pass', field_paths: key.field_paths, message: null }
}
