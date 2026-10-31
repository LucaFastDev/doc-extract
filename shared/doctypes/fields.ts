import { parseDecimal, type Decimal } from './decimal.ts'

// What every document type shares (PRD section 4): field kinds, the common fields, the shape of a
// field in a tool's input, the rows and check results an extraction stores, and the arithmetic
// tolerance (OQ-7). Imports within shared/ carry their .ts extension, which Deno needs.

export type FieldKind = 'text' | 'date' | 'amount' | 'number' | 'percent'

export interface FieldDef {
  name: string
  kind: FieldKind
  /** For the tool's schema: what the field means and the labels it is printed under. */
  description: string
}

/** One field as Claude returns it. An empty value means the document does not show it. */
export interface ExtractedField {
  value: string
  confidence: number
}

/** One extraction_fields row: a field, or a line-item cell such as line_items[3].amount. */
export interface FieldRow {
  path: string
  kind: FieldKind
  extracted_value: string | null
  confidence: number
  flags: string[]
}

/** One check_results row. */
export interface CheckResult {
  check_id: string
  status: 'pass' | 'fail' | 'skipped'
  /** The fields the check reads; a failed check flags these. */
  field_paths: string[]
  message: string | null
}

/** A document's values by field, empty ones as null, for the checks. */
export interface DocumentValues {
  fields: Record<string, string | null>
  line_items: Record<string, string | null>[]
}

/** A tool as the Messages API takes it, with strict schema validation (ARCHITECTURE.md section 9). */
export interface ToolDefinition {
  name: string
  description: string
  strict: true
  input_schema: Record<string, unknown>
}

/** Every type's fields (PRD section 4): the language and the currency, as code and as printed. */
export const COMMON_FIELDS: FieldDef[] = [
  { name: 'language', kind: 'text', description: 'The language the document is written in, as a BCP 47 code such as "en" or "de".' },
  {
    name: 'currency',
    kind: 'text',
    description:
      'The currency of the amounts as an ISO 4217 code such as "EUR". When none is printed, give the most likely one from the context.',
  },
  {
    name: 'currency_as_printed',
    kind: 'text',
    description: 'The currency exactly as printed, such as "€", "EUR" or "Euro"; empty when none is printed.',
  },
]

/**
 * A field in a strict tool's input. The value is a string, never null: strict tool use allows
 * only 16 nullable parameters across a request, and a type has far more fields, so an empty
 * string stands for "not on the document" and is stored as null.
 */
export function fieldSchema(def: FieldDef) {
  return {
    type: 'object',
    description: def.description,
    properties: {
      value: { type: 'string', description: valueDescription(def.kind) },
      confidence: { type: 'number', description: 'How sure you are of the value, from 0 to 1.' },
    },
    required: ['value', 'confidence'],
    additionalProperties: false,
  }
}

function valueDescription(kind: FieldKind): string {
  switch (kind) {
    case 'date':
      return 'The date as YYYY-MM-DD, or an empty string when it is not printed.'
    case 'amount':
      return 'The amount as a plain decimal with the printed decimals and no thousands separators or currency, such as "1180.00"; negative with a leading "-"; an empty string when it is not printed.'
    case 'number':
      return 'The number as a plain decimal such as "3" or "2.5", or an empty string when it is not printed.'
    case 'percent':
      return 'The percentage as a plain decimal without "%", such as "19" for 19%, or an empty string when it is not printed.'
    default:
      return 'The text exactly as printed, untranslated, or an empty string when it is not printed.'
  }
}

/** ISO 4217 currencies whose minor unit is 0, where amounts are equal within 1 (OQ-7). */
const NO_MINOR_UNIT = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])

/** The tolerance for the arithmetic checks: app_config.amount_tolerance, or 1 with no minor unit. */
export function amountTolerance(currency: string | null, configured: string): Decimal {
  if (currency && NO_MINOR_UNIT.has(currency.trim().toUpperCase())) return { units: 1n, scale: 0 }
  const tolerance = parseDecimal(configured)
  if (!tolerance) throw new Error(`amount_tolerance is not a decimal: ${configured}`)
  return tolerance
}

/** A value read for a check: empty, not a number, or a decimal. */
export type Reading = { state: 'empty' } | { state: 'invalid'; text: string } | { state: 'ok'; value: Decimal }

export function read(value: string | null | undefined): Reading {
  if (value === null || value === undefined || value.trim() === '') return { state: 'empty' }
  const parsed = parseDecimal(value)
  return parsed ? { state: 'ok', value: parsed } : { state: 'invalid', text: value.trim() }
}
