import { BANK_STATEMENT } from './bank-statement.ts'
import { currencyGuessed } from './currency.ts'
import { DELIVERY_NOTE } from './delivery-note.ts'
import type { DocTypeDef } from './doctype.ts'
import type { DuplicateKey } from './duplicate.ts'
import {
  amountTolerance,
  LAST4_FIELDS,
  lastFour,
  type CheckResult,
  type DocumentValues,
  type ExtractedField,
  type FieldDef,
  type FieldRow,
  type ToolDefinition,
} from './fields.ts'
import { INVOICE } from './invoice.ts'
import { PURCHASE_ORDER } from './purchase-order.ts'
import { QUOTE } from './quote.ts'
import { RECEIPT } from './receipt.ts'
import { schemaErrors } from './schema.ts'

// The six document types and what turns a tool call into stored rows (ARCHITECTURE.md sections
// 6.3 and 9). Each type is defined once, in its own module (PRD US-3.1 AC-1).

export const DOC_TYPES = {
  invoice: INVOICE,
  receipt: RECEIPT,
  bank_statement: BANK_STATEMENT,
  purchase_order: PURCHASE_ORDER,
  delivery_note: DELIVERY_NOTE,
  quote: QUOTE,
} satisfies Record<string, DocTypeDef>

export type DocType = keyof typeof DOC_TYPES

/** The tool Claude calls for anything that is none of the types (OQ-1). */
export const RECORD_NOT_SUPPORTED: ToolDefinition = {
  name: 'record_not_supported',
  description:
    'Call this instead of a record_ tool when the document is not one of the supported types: for example a letter, a contract, a payslip or a photo that is not a business document. Give a short reason.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'One short sentence saying what the document is, such as "This is a cover letter."' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
}

/** The type a tool records, 'not_supported' for record_not_supported, or null for no known tool. */
export function docTypeOfTool(name: string): DocType | 'not_supported' | null {
  if (name === RECORD_NOT_SUPPORTED.name) return 'not_supported'
  const found = (Object.keys(DOC_TYPES) as DocType[]).find((t) => DOC_TYPES[t].tool.name === name)
  return found ?? null
}

/** Every type's tool and record_not_supported to detect the type; only the chosen type's otherwise (OQ-1). */
export function toolsFor(docType: DocType | null): ToolDefinition[] {
  if (docType) return [DOC_TYPES[docType].tool]
  return [...(Object.keys(DOC_TYPES) as DocType[]).map((t) => DOC_TYPES[t].tool), RECORD_NOT_SUPPORTED]
}

export interface ResultConfig {
  /** app_config.confidence_threshold (OQ-8). */
  confidenceThreshold: number
  /** app_config.amount_tolerance, as a decimal string (OQ-7). */
  amountTolerance: string
  /** Today's date in UTC, YYYY-MM-DD, for the date checks (OQ-6). */
  today: string
}

export type PreparedResult =
  | { ok: true; fields: FieldRow[]; checks: CheckResult[]; duplicate: DuplicateKey }
  | { ok: false; errors: string[] }

const LAST4 = new Set<string>(LAST4_FIELDS)

/**
 * An empty or blank value is a field the document does not show. A card, account or IBAN number
 * keeps only its last four characters (OQ-29).
 */
function normalise(f: FieldDef, value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  return LAST4.has(f.name) ? lastFour(trimmed) : trimmed
}

/**
 * Validates the tool input against the type's schema again, normalises it, flattens it into one
 * row per field and line-item cell, runs the type's checks, and flags each row: low_confidence
 * below the threshold (OQ-8), check_failed when a failed check names it (US-4.1 AC-2), and
 * currency_guessed on the currency when none is printed or only an ambiguous symbol (OQ-16).
 * The duplicate key goes to record_extraction, which runs the duplicate query (OQ-9).
 */
export function prepareResult(docType: DocType, input: unknown, config: ResultConfig): PreparedResult {
  const def: DocTypeDef = DOC_TYPES[docType]
  const errors = schemaErrors(def.tool.input_schema, input)
  if (errors.length > 0) return { ok: false, errors }

  const header = input as Record<string, ExtractedField>
  const lines = (input as Record<string, unknown>)[def.linesKey] as Record<string, ExtractedField>[]
  const rows: FieldRow[] = []
  const add = (path: string, f: FieldDef, extracted: ExtractedField) => {
    if (extracted.confidence < 0 || extracted.confidence > 1) errors.push(`${path}.confidence must be between 0 and 1`)
    rows.push({ path, kind: f.kind, extracted_value: normalise(f, extracted.value), confidence: extracted.confidence, flags: [] })
  }
  for (const f of def.fields) add(f.name, f, header[f.name])
  lines.forEach((line, i) => {
    for (const f of def.lineFields) add(`line_items[${i}].${f.name}`, f, line[f.name])
  })
  if (errors.length > 0) return { ok: false, errors }

  const values: DocumentValues = {
    fields: Object.fromEntries(def.fields.map((f) => [f.name, normalise(f, header[f.name].value)])),
    line_items: lines.map((line) => Object.fromEntries(def.lineFields.map((f) => [f.name, normalise(f, line[f.name].value)]))),
  }
  const checks = def.checks(values, {
    tolerance: amountTolerance(values.fields.currency ?? null, config.amountTolerance),
    today: config.today,
  })

  const failed = new Set(checks.filter((c) => c.status === 'fail').flatMap((c) => c.field_paths))
  const guessed = def.flagsCurrency && currencyGuessed(values.fields.currency_as_printed)
  for (const row of rows) {
    if (row.confidence < config.confidenceThreshold) row.flags.push('low_confidence')
    if (failed.has(row.path)) row.flags.push('check_failed')
    if (guessed && row.path === 'currency') row.flags.push('currency_guessed')
  }
  return { ok: true, fields: rows, checks, duplicate: def.duplicateKey(values) }
}
