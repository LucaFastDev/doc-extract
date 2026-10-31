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

const LANGUAGE: FieldDef = {
  name: 'language',
  kind: 'text',
  description: 'The language the document is written in, as a BCP 47 code such as "en" or "de".',
}

const CURRENCY_AS_PRINTED: FieldDef = {
  name: 'currency_as_printed',
  kind: 'text',
  description: 'The currency exactly as printed, such as "€", "EUR" or "Euro"; empty when none is printed.',
}

/** Every type's fields (PRD section 4): the language and the currency, as code and as printed. */
export const COMMON_FIELDS: FieldDef[] = [
  LANGUAGE,
  {
    name: 'currency',
    kind: 'text',
    description:
      'The currency of the amounts as an ISO 4217 code such as "EUR". When none is printed, give the most likely one from the context.',
  },
  CURRENCY_AS_PRINTED,
]

/** The common fields of a delivery note, which has no amounts: its currency may be empty (PRD 4.1). */
export const COMMON_FIELDS_WITHOUT_AMOUNTS: FieldDef[] = [
  LANGUAGE,
  {
    name: 'currency',
    kind: 'text',
    description: 'The currency as an ISO 4217 code such as "EUR" if the document prints one; otherwise an empty string.',
  },
  CURRENCY_AS_PRINTED,
]

/** The fields' schemas by name, for a tool's input. */
export const properties = (defs: FieldDef[]) => Object.fromEntries(defs.map((d) => [d.name, fieldSchema(d)]))

const names = (defs: FieldDef[]) => defs.map((d) => d.name)

/** A record_<type> tool: every header field and the list of lines, all required (section 9). */
export function recordTool(o: {
  name: string
  description: string
  fields: FieldDef[]
  linesKey: string
  linesDescription: string
  lineFields: FieldDef[]
}): ToolDefinition {
  return {
    name: o.name,
    description: o.description,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ...properties(o.fields),
        [o.linesKey]: {
          type: 'array',
          description: o.linesDescription,
          items: {
            type: 'object',
            properties: properties(o.lineFields),
            required: names(o.lineFields),
            additionalProperties: false,
          },
        },
      },
      required: [...names(o.fields), o.linesKey],
      additionalProperties: false,
    },
  }
}

/** The fields of which only the last four characters are stored, in every type (OQ-29). */
export const LAST4_FIELDS = ['card_last4', 'account_number_last4', 'iban_last4'] as const

/** A card, account or IBAN number cut to its last four characters, without spaces (OQ-29). */
export function lastFour(value: string): string {
  return value.replace(/\s/g, '').slice(-4)
}

/**
 * A copy of a tool input, or a whole response, with every last-four field's value cut, so the
 * full number is not stored in extractions.raw_output either (OQ-29).
 */
export function redactLastFour<T>(json: T): T {
  if (Array.isArray(json)) return json.map(redactLastFour) as T
  if (!json || typeof json !== 'object') return json
  return Object.fromEntries(
    Object.entries(json as Record<string, unknown>).map(([key, child]) => {
      const field = child as { value?: unknown } | null
      if ((LAST4_FIELDS as readonly string[]).includes(key) && field && typeof field === 'object' && typeof field.value === 'string') {
        return [key, { ...field, value: lastFour(field.value) }]
      }
      return [key, redactLastFour(child)]
    }),
  ) as T
}

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
