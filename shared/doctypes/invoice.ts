import { formatAmount, formatNumber, multiply, sum, subtract, add, withinTolerance, type Decimal } from './decimal.ts'
import {
  COMMON_FIELDS,
  fieldSchema,
  read,
  type CheckResult,
  type DocumentValues,
  type FieldDef,
  type Reading,
  type ToolDefinition,
} from './fields.ts'

// The invoice type (PRD section 4.1 Invoice): its fields, its tool record_invoice, and its
// arithmetic checks A1 to A4 (US-4.1, OQ-7, OQ-43). D1, D2 and U1 come in milestone 6.

export type InvoiceValues = DocumentValues

export const INVOICE_FIELDS: FieldDef[] = [
  ...COMMON_FIELDS,
  { name: 'vendor_name', kind: 'text', description: 'The seller who issued the invoice (supplier, vendor, Lieferant, fournisseur).' },
  { name: 'vendor_address', kind: 'text', description: 'The seller’s postal address, as printed.' },
  { name: 'vendor_tax_id', kind: 'text', description: 'The seller’s tax or VAT number (VAT no., USt-IdNr., TVA, NIF).' },
  { name: 'customer_name', kind: 'text', description: 'The buyer the invoice is addressed to (bill to, customer, Kunde, client).' },
  { name: 'customer_address', kind: 'text', description: 'The buyer’s postal address, as printed.' },
  { name: 'customer_tax_id', kind: 'text', description: 'The buyer’s tax or VAT number, if printed.' },
  { name: 'invoice_number', kind: 'text', description: 'The invoice number (invoice no., Rechnungsnummer, numéro de facture).' },
  { name: 'purchase_order_number', kind: 'text', description: 'The buyer’s purchase order number (PO, Bestellnummer), if printed.' },
  { name: 'payment_terms', kind: 'text', description: 'The payment terms as printed, such as "Net 30".' },
  { name: 'invoice_date', kind: 'date', description: 'The date the invoice was issued (invoice date, Rechnungsdatum, date de facture).' },
  { name: 'due_date', kind: 'date', description: 'The date payment is due (due date, fällig am, échéance).' },
  { name: 'subtotal', kind: 'amount', description: 'The total before tax, discount and shipping (subtotal, net, Zwischensumme).' },
  { name: 'tax_total', kind: 'amount', description: 'The total tax (VAT, sales tax, MwSt, TVA).' },
  { name: 'shipping', kind: 'amount', description: 'Shipping or delivery charges (Versand, frais de port).' },
  { name: 'discount_total', kind: 'amount', description: 'The total discount, as a positive amount (Rabatt, remise).' },
  { name: 'total', kind: 'amount', description: 'The invoice total including tax (total, gross, Gesamtbetrag).' },
  { name: 'amount_paid', kind: 'amount', description: 'The amount already paid or deposited, if printed.' },
  { name: 'amount_due', kind: 'amount', description: 'The balance still to pay (amount due, balance due, zu zahlen).' },
]

export const INVOICE_LINE_ITEM_FIELDS: FieldDef[] = [
  { name: 'description', kind: 'text', description: 'What the line is for, as printed.' },
  { name: 'item_code', kind: 'text', description: 'The item or article code (SKU, Art.-Nr.), if printed.' },
  { name: 'quantity', kind: 'number', description: 'The quantity (qty, Menge, quantité).' },
  { name: 'unit', kind: 'text', description: 'The unit of the quantity, such as "pcs", "h" or "kg".' },
  { name: 'unit_price', kind: 'amount', description: 'The price of one unit (unit price, Einzelpreis, prix unitaire).' },
  { name: 'tax_rate', kind: 'percent', description: 'The line’s tax rate, if printed.' },
  { name: 'amount', kind: 'amount', description: 'The line total (amount, Betrag, montant).' },
]

const properties = (defs: FieldDef[]) => Object.fromEntries(defs.map((d) => [d.name, fieldSchema(d)]))
const names = (defs: FieldDef[]) => defs.map((d) => d.name)

export const RECORD_INVOICE: ToolDefinition = {
  name: 'record_invoice',
  description:
    'Record the fields of an invoice: a document from a seller asking a buyer to pay for goods or services, with an invoice number, dates, amounts and usually line items. Give every field; for one the document does not show, give an empty value. Read only what is printed and never invent a value.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      ...properties(INVOICE_FIELDS),
      line_items: {
        type: 'array',
        description: 'The invoice’s lines in the order printed; an empty list when there are none.',
        items: {
          type: 'object',
          properties: properties(INVOICE_LINE_ITEM_FIELDS),
          required: names(INVOICE_LINE_ITEM_FIELDS),
          additionalProperties: false,
        },
      },
    },
    required: [...names(INVOICE_FIELDS), 'line_items'],
    additionalProperties: false,
  },
}

// Checks --------------------------------------------------------------------------------------

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const linePath = (i: number, name: string) => `line_items[${i}].${name}`

/** A1: on each line, quantity × unit_price = amount. Lines missing any of the three are left out. */
export function checkA1(v: InvoiceValues, tolerance: Decimal): CheckResult {
  const all: string[] = []
  const checked: string[] = []
  const failed: string[] = []
  const problems: string[] = []

  v.line_items.forEach((line, i) => {
    const paths = ['quantity', 'unit_price', 'amount'].map((n) => linePath(i, n))
    all.push(...paths)
    const inputs: [string, string, Reading][] = [
      ['quantity', 'number', read(line.quantity)],
      ['unit price', 'amount', read(line.unit_price)],
      ['amount', 'amount', read(line.amount)],
    ]
    if (inputs.some(([, , r]) => r.state === 'empty')) return
    const invalid = inputs.find(([, , r]) => r.state === 'invalid')
    if (invalid) {
      failed.push(...paths)
      problems.push(`Line ${i + 1}: ${invalid[0]} "${(invalid[2] as { text: string }).text}" is not a${invalid[1] === 'amount' ? 'n' : ''} ${invalid[1]}`)
      return
    }
    const [q, p, a] = inputs.map(([, , r]) => (r as { value: Decimal }).value)
    const product = multiply(q, p)
    if (withinTolerance(product, a, tolerance)) {
      checked.push(...paths)
    } else {
      failed.push(...paths)
      problems.push(`Line ${i + 1}: ${formatNumber(q)} × ${formatAmount(p)} = ${formatAmount(product)}; amount is ${formatAmount(a)}`)
    }
  })

  if (problems.length > 0) return { check_id: 'A1', status: 'fail', field_paths: failed, message: problems.join('. ') }
  if (checked.length === 0) {
    return { check_id: 'A1', status: 'skipped', field_paths: all, message: 'Skipped: no line has a quantity, a unit price and an amount.' }
  }
  return { check_id: 'A1', status: 'pass', field_paths: checked, message: null }
}

/** A2: the line amounts sum to the subtotal. */
export function checkA2(v: InvoiceValues, tolerance: Decimal): CheckResult {
  const amountPaths = v.line_items.map((_, i) => linePath(i, 'amount'))
  const field_paths = [...amountPaths, 'subtotal']
  const skipped = (why: string): CheckResult => ({ check_id: 'A2', status: 'skipped', field_paths, message: `Skipped: ${why}` })
  const fail = (message: string): CheckResult => ({ check_id: 'A2', status: 'fail', field_paths, message })

  if (v.line_items.length === 0) return skipped('there are no line items.')
  const subtotal = read(v.fields.subtotal)
  if (subtotal.state === 'empty') return skipped('no subtotal is printed.')
  const amounts = v.line_items.map((line) => read(line.amount))
  const missing = amounts.findIndex((r) => r.state === 'empty')
  if (missing >= 0) return skipped(`line ${missing + 1} has no amount.`)
  if (subtotal.state === 'invalid') return fail(`Subtotal "${subtotal.text}" is not an amount`)
  const bad = amounts.findIndex((r) => r.state === 'invalid')
  if (bad >= 0) return fail(`Line ${bad + 1}: amount "${(amounts[bad] as { text: string }).text}" is not an amount`)

  const total = sum(amounts.map((r) => (r as { value: Decimal }).value))
  if (withinTolerance(total, subtotal.value, tolerance)) return { check_id: 'A2', status: 'pass', field_paths, message: null }
  return fail(`Line items sum to ${formatAmount(total)}; subtotal is ${formatAmount(subtotal.value)}`)
}

interface Term {
  name: string
  label: string
  sign: '+' | '−'
}

/** A check of the form first ± terms… = result, as A3 and A4 are. */
function formulaCheck(
  id: string,
  v: InvoiceValues,
  tolerance: Decimal,
  first: Omit<Term, 'sign'>,
  terms: Term[],
  result: Omit<Term, 'sign'>,
): CheckResult {
  const parts = [first, ...terms, result]
  const field_paths = parts.map((p) => p.name)
  const readings = parts.map((p) => read(v.fields[p.name]))

  const empty = readings.findIndex((r) => r.state === 'empty')
  if (empty >= 0) {
    return { check_id: id, status: 'skipped', field_paths, message: `Skipped: no ${parts[empty].label} is printed.` }
  }
  const invalid = readings.findIndex((r) => r.state === 'invalid')
  if (invalid >= 0) {
    const text = (readings[invalid] as { text: string }).text
    return { check_id: id, status: 'fail', field_paths, message: `${capitalised(parts[invalid].label)} "${text}" is not an amount` }
  }

  const values = readings.map((r) => (r as { value: Decimal }).value)
  let computed = values[0]
  terms.forEach((t, i) => {
    computed = t.sign === '+' ? add(computed, values[i + 1]) : subtract(computed, values[i + 1])
  })
  const actual = values[values.length - 1]
  if (withinTolerance(computed, actual, tolerance)) return { check_id: id, status: 'pass', field_paths, message: null }

  const formula = [
    `${capitalised(first.label)} ${formatAmount(values[0])}`,
    ...terms.map((t, i) => `${t.sign} ${t.label} ${formatAmount(values[i + 1])}`),
  ].join(' ')
  return {
    check_id: id,
    status: 'fail',
    field_paths,
    message: `${formula} = ${formatAmount(computed)}; ${result.label} is ${formatAmount(actual)}`,
  }
}

/** A3: subtotal − discount_total + shipping + tax_total = total. Skipped when any is not printed. */
export function checkA3(v: InvoiceValues, tolerance: Decimal): CheckResult {
  return formulaCheck(
    'A3',
    v,
    tolerance,
    { name: 'subtotal', label: 'subtotal' },
    [
      { name: 'discount_total', label: 'discount', sign: '−' },
      { name: 'shipping', label: 'shipping', sign: '+' },
      { name: 'tax_total', label: 'tax', sign: '+' },
    ],
    { name: 'total', label: 'total' },
  )
}

/** A4: total − amount_paid = amount_due. */
export function checkA4(v: InvoiceValues, tolerance: Decimal): CheckResult {
  return formulaCheck(
    'A4',
    v,
    tolerance,
    { name: 'total', label: 'total' },
    [{ name: 'amount_paid', label: 'amount paid', sign: '−' }],
    { name: 'amount_due', label: 'amount due' },
  )
}

/** Every invoice check of this milestone, in order. */
export function invoiceChecks(v: InvoiceValues, tolerance: Decimal): CheckResult[] {
  return [checkA1(v, tolerance), checkA2(v, tolerance), checkA3(v, tolerance), checkA4(v, tolerance)]
}
