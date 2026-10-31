import type { Decimal } from './decimal.ts'
import {
  amountTolerance,
  type CheckResult,
  type DocumentValues,
  type ExtractedField,
  type FieldDef,
  type FieldRow,
  type ToolDefinition,
} from './fields.ts'
import { INVOICE_FIELDS, INVOICE_LINE_ITEM_FIELDS, invoiceChecks, RECORD_INVOICE } from './invoice.ts'
import { schemaErrors } from './schema.ts'

// The document types and what turns a tool call into stored rows (ARCHITECTURE.md sections 6.3
// and 9). This milestone has the invoice; milestone 6 adds the other five here.

interface DocTypeDef {
  tool: ToolDefinition
  fields: FieldDef[]
  lineItemFields: FieldDef[]
  checks: (values: DocumentValues, tolerance: Decimal) => CheckResult[]
}

export const DOC_TYPES = {
  invoice: { tool: RECORD_INVOICE, fields: INVOICE_FIELDS, lineItemFields: INVOICE_LINE_ITEM_FIELDS, checks: invoiceChecks },
} satisfies Record<string, DocTypeDef>

export type DocType = keyof typeof DOC_TYPES

/** The tool Claude calls for anything that is none of the types (OQ-1). */
export const RECORD_NOT_SUPPORTED: ToolDefinition = {
  name: 'record_not_supported',
  description:
    'Call this instead of a record_ tool when the document is not one of the supported types: for example a letter, a contract, a receipt or a photo that is not a business document. Give a short reason.',
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
}

export type PreparedResult = { ok: true; fields: FieldRow[]; checks: CheckResult[] } | { ok: false; errors: string[] }

/** An empty or blank value is a field the document does not show. */
const normalise = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/**
 * Validates the tool input against the type's schema again, normalises it, flattens it into one
 * row per field and line-item cell, runs the type's checks, and flags each row: low_confidence
 * below the threshold (OQ-8), check_failed when a failed check names it (US-4.1 AC-2).
 */
export function prepareResult(docType: DocType, input: unknown, config: ResultConfig): PreparedResult {
  const def: DocTypeDef = DOC_TYPES[docType]
  const errors = schemaErrors(def.tool.input_schema, input)
  if (errors.length > 0) return { ok: false, errors }

  const record = input as Record<string, ExtractedField> & { line_items: Record<string, ExtractedField>[] }
  const rows: FieldRow[] = []
  const add = (path: string, f: FieldDef, extracted: ExtractedField) => {
    if (extracted.confidence < 0 || extracted.confidence > 1) errors.push(`${path}.confidence must be between 0 and 1`)
    rows.push({ path, kind: f.kind, extracted_value: normalise(extracted.value), confidence: extracted.confidence, flags: [] })
  }
  for (const f of def.fields) add(f.name, f, record[f.name])
  record.line_items.forEach((line, i) => {
    for (const f of def.lineItemFields) add(`line_items[${i}].${f.name}`, f, line[f.name])
  })
  if (errors.length > 0) return { ok: false, errors }

  const values: DocumentValues = {
    fields: Object.fromEntries(def.fields.map((f) => [f.name, normalise(record[f.name].value)])),
    line_items: record.line_items.map((line) =>
      Object.fromEntries(def.lineItemFields.map((f) => [f.name, normalise(line[f.name].value)])),
    ),
  }
  const checks = def.checks(values, amountTolerance(values.fields.currency ?? null, config.amountTolerance))

  const failed = new Set(checks.filter((c) => c.status === 'fail').flatMap((c) => c.field_paths))
  for (const row of rows) {
    if (row.confidence < config.confidenceThreshold) row.flags.push('low_confidence')
    if (failed.has(row.path)) row.flags.push('check_failed')
  }
  return { ok: true, fields: rows, checks }
}
