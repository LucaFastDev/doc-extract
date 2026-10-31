import type { Decimal } from './decimal.ts'
import { dateCheck, formulaCheck, lineProductCheck, subtotalCheck, type CheckContext } from './checks.ts'
import { checkU1, duplicateKey, type DuplicateKey } from './duplicate.ts'
import type { DocTypeDef } from './doctype.ts'
import { COMMON_FIELDS, recordTool, type CheckResult, type DocumentValues, type FieldDef } from './fields.ts'

// The receipt type (PRD section 4.1 Receipt): its fields, its tool record_receipt, and its checks
// A1 to A3, D1 and U1. card_last4 keeps only its last four characters (OQ-29, index.ts).

export const RECEIPT_FIELDS: FieldDef[] = [
  ...COMMON_FIELDS,
  { name: 'merchant_name', kind: 'text', description: 'The shop, restaurant or business that issued the receipt.' },
  { name: 'merchant_address', kind: 'text', description: 'The merchant’s address, as printed.' },
  { name: 'merchant_tax_id', kind: 'text', description: 'The merchant’s tax or VAT number (VAT no., USt-IdNr., TVA, NIF), if printed.' },
  { name: 'receipt_number', kind: 'text', description: 'The receipt, transaction or till number (Beleg-Nr., ticket n°), if printed.' },
  { name: 'payment_method', kind: 'text', description: 'How it was paid, as printed, such as "Cash", "Visa" or "EC-Karte".' },
  { name: 'card_last4', kind: 'text', description: 'The last four digits of the card used, if printed; never more than four.' },
  { name: 'transaction_date', kind: 'date', description: 'The date of the purchase (Datum, date).' },
  { name: 'transaction_time', kind: 'text', description: 'The time of the purchase as HH:MM in 24-hour time, such as "14:05".' },
  { name: 'subtotal', kind: 'amount', description: 'The total before tax and tip (subtotal, net, Zwischensumme).' },
  { name: 'tax_total', kind: 'amount', description: 'The total tax (VAT, sales tax, MwSt, TVA).' },
  { name: 'tip', kind: 'amount', description: 'The tip or gratuity (Trinkgeld, pourboire), if printed.' },
  { name: 'total', kind: 'amount', description: 'The total paid (total, Summe, Gesamt, total TTC).' },
]

export const RECEIPT_LINE_ITEM_FIELDS: FieldDef[] = [
  { name: 'description', kind: 'text', description: 'What was bought, as printed.' },
  { name: 'quantity', kind: 'number', description: 'The quantity (qty, Menge, quantité).' },
  { name: 'unit_price', kind: 'amount', description: 'The price of one unit.' },
  { name: 'amount', kind: 'amount', description: 'The line total.' },
]

export const RECORD_RECEIPT = recordTool({
  name: 'record_receipt',
  description:
    'Record the fields of a receipt: proof of a purchase already paid, from a shop, restaurant, taxi or other merchant, with a date, often a time, the items bought and the total paid. Give every field; for one the document does not show, give an empty value. Read only what is printed and never invent a value.',
  fields: RECEIPT_FIELDS,
  linesKey: 'line_items',
  linesDescription: 'The items bought in the order printed; an empty list when there are none.',
  lineFields: RECEIPT_LINE_ITEM_FIELDS,
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

/** A3: subtotal + tax_total + tip = total. */
export function checkA3(v: DocumentValues, tolerance: Decimal): CheckResult {
  return formulaCheck(
    'A3',
    v,
    tolerance,
    { name: 'subtotal', label: 'subtotal' },
    [
      { name: 'tax_total', label: 'tax', sign: '+' },
      { name: 'tip', label: 'tip', sign: '+' },
    ],
    { name: 'total', label: 'total' },
  )
}

/** D1: transaction_date is not in the future. */
export function checkD1(v: DocumentValues, today: string): CheckResult {
  return dateCheck('D1', v, today, [{ name: 'transaction_date', label: 'transaction date', notFuture: true }])
}

/** U1's key: the merchant, the transaction date and time, and the total. */
export function receiptDuplicateKey(v: DocumentValues): DuplicateKey {
  return duplicateKey(
    'receipt',
    v,
    [
      { name: 'merchant_name', kind: 'text' },
      { name: 'transaction_date', kind: 'date' },
      { name: 'transaction_time', kind: 'text' },
      { name: 'total', kind: 'amount' },
    ],
    'merchant, transaction date, time and total',
  )
}

export function receiptChecks(v: DocumentValues, c: CheckContext): CheckResult[] {
  return [
    checkA1(v, c.tolerance),
    checkA2(v, c.tolerance),
    checkA3(v, c.tolerance),
    checkD1(v, c.today),
    checkU1(receiptDuplicateKey(v), null),
  ]
}

export const RECEIPT: DocTypeDef = {
  tool: RECORD_RECEIPT,
  fields: RECEIPT_FIELDS,
  linesKey: 'line_items',
  lineFields: RECEIPT_LINE_ITEM_FIELDS,
  checks: receiptChecks,
  duplicateKey: receiptDuplicateKey,
  flagsCurrency: true,
}
