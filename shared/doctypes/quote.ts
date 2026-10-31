import type { Decimal } from './decimal.ts'
import { dateCheck, formulaCheck, lineProductCheck, subtotalCheck, type CheckContext } from './checks.ts'
import { checkU1, duplicateKey, type DuplicateKey } from './duplicate.ts'
import type { DocTypeDef } from './doctype.ts'
import { COMMON_FIELDS, recordTool, type CheckResult, type DocumentValues, type FieldDef } from './fields.ts'

// The quote type (PRD section 4.1 Quote): its fields, its tool record_quote, and its checks A1 to
// A3, D1, D2 and U1.

export const QUOTE_FIELDS: FieldDef[] = [
  ...COMMON_FIELDS,
  { name: 'supplier_name', kind: 'text', description: 'The business offering the goods or services (supplier, Anbieter, fournisseur).' },
  { name: 'supplier_address', kind: 'text', description: 'The supplier’s postal address, as printed.' },
  { name: 'customer_name', kind: 'text', description: 'The customer the quote is addressed to (customer, Kunde, client).' },
  { name: 'customer_address', kind: 'text', description: 'The customer’s postal address, as printed.' },
  { name: 'quote_number', kind: 'text', description: 'The quote or estimate number (quote no., Angebotsnummer, numéro de devis).' },
  { name: 'payment_terms', kind: 'text', description: 'The payment terms as printed, such as "50% on order".' },
  { name: 'quote_date', kind: 'date', description: 'The date of the quote (date, Angebotsdatum, date du devis).' },
  { name: 'valid_until', kind: 'date', description: 'The last day the quote is valid (valid until, gültig bis, valable jusqu’au).' },
  { name: 'subtotal', kind: 'amount', description: 'The total before discount and tax (subtotal, net, Zwischensumme).' },
  { name: 'discount_total', kind: 'amount', description: 'The total discount, as a positive amount (Rabatt, remise).' },
  { name: 'tax_total', kind: 'amount', description: 'The total tax (VAT, sales tax, MwSt, TVA).' },
  { name: 'total', kind: 'amount', description: 'The quoted total including tax (total, Gesamtbetrag).' },
]

export const QUOTE_LINE_ITEM_FIELDS: FieldDef[] = [
  { name: 'description', kind: 'text', description: 'What is offered, as printed.' },
  { name: 'item_code', kind: 'text', description: 'The item or article code (SKU, Art.-Nr.), if printed.' },
  { name: 'quantity', kind: 'number', description: 'The quantity (qty, Menge, quantité).' },
  { name: 'unit', kind: 'text', description: 'The unit of the quantity, such as "pcs", "h" or "kg".' },
  { name: 'unit_price', kind: 'amount', description: 'The price of one unit (unit price, Einzelpreis, prix unitaire).' },
  { name: 'amount', kind: 'amount', description: 'The line total (amount, Betrag, montant).' },
]

export const RECORD_QUOTE = recordTool({
  name: 'record_quote',
  description:
    'Record the fields of a quote: a supplier’s offer of goods or services at stated prices, not yet ordered or billed (quotation, estimate, Angebot, devis), usually with a quote number and a date it is valid until. Give every field; for one the document does not show, give an empty value. Read only what is printed and never invent a value.',
  fields: QUOTE_FIELDS,
  linesKey: 'line_items',
  linesDescription: 'The items offered in the order printed; an empty list when there are none.',
  lineFields: QUOTE_LINE_ITEM_FIELDS,
})

// Checks --------------------------------------------------------------------------------------

/** A1: on each line, quantity × unit_price = amount. */
export function checkA1(v: DocumentValues, tolerance: Decimal): CheckResult {
  return lineProductCheck('A1', v, tolerance)
}

/** A2: the line amounts sum to the subtotal. */
export function checkA2(v: DocumentValues, tolerance: Decimal): CheckResult {
  return subtotalCheck('A2', v, tolerance)
}

/** A3: subtotal − discount_total + tax_total = total. */
export function checkA3(v: DocumentValues, tolerance: Decimal): CheckResult {
  return formulaCheck(
    'A3',
    v,
    tolerance,
    { name: 'subtotal', label: 'subtotal' },
    [
      { name: 'discount_total', label: 'discount', sign: '−' },
      { name: 'tax_total', label: 'tax', sign: '+' },
    ],
    { name: 'total', label: 'total' },
  )
}

/** D1: quote_date is not in the future. */
export function checkD1(v: DocumentValues, today: string): CheckResult {
  return dateCheck('D1', v, today, [{ name: 'quote_date', label: 'quote date', notFuture: true }])
}

/** D2: valid_until ≥ quote_date. */
export function checkD2(v: DocumentValues, today: string): CheckResult {
  return dateCheck(
    'D2',
    v,
    today,
    [
      { name: 'quote_date', label: 'quote date' },
      { name: 'valid_until', label: 'valid until' },
    ],
    [['quote_date', 'valid_until']],
  )
}

/** U1's key: the supplier and the quote number. */
export function quoteDuplicateKey(v: DocumentValues): DuplicateKey {
  return duplicateKey(
    'quote',
    v,
    [
      { name: 'supplier_name', kind: 'text' },
      { name: 'quote_number', kind: 'text' },
    ],
    'supplier and quote number',
  )
}

export function quoteChecks(v: DocumentValues, c: CheckContext): CheckResult[] {
  return [
    checkA1(v, c.tolerance),
    checkA2(v, c.tolerance),
    checkA3(v, c.tolerance),
    checkD1(v, c.today),
    checkD2(v, c.today),
    checkU1(quoteDuplicateKey(v), null),
  ]
}

export const QUOTE: DocTypeDef = {
  tool: RECORD_QUOTE,
  fields: QUOTE_FIELDS,
  linesKey: 'line_items',
  lineFields: QUOTE_LINE_ITEM_FIELDS,
  checks: quoteChecks,
  duplicateKey: quoteDuplicateKey,
  flagsCurrency: true,
}
