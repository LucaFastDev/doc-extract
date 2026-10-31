import type { Decimal } from './decimal.ts'
import { dateCheck, formulaCheck, lineProductCheck, subtotalCheck, type CheckContext } from './checks.ts'
import { checkU1, duplicateKey, type DuplicateKey } from './duplicate.ts'
import type { DocTypeDef } from './doctype.ts'
import { COMMON_FIELDS, recordTool, type CheckResult, type DocumentValues, type FieldDef } from './fields.ts'

// The invoice type (PRD section 4.1 Invoice): its fields, its tool record_invoice, and its checks
// A1 to A4 (US-4.1, OQ-7, OQ-43), D1 and D2 (OQ-6) and U1 (OQ-9).

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

export const RECORD_INVOICE = recordTool({
  name: 'record_invoice',
  description:
    'Record the fields of an invoice: a document from a seller asking a buyer to pay for goods or services, with an invoice number, dates, amounts and usually line items. Give every field; for one the document does not show, give an empty value. Read only what is printed and never invent a value.',
  fields: INVOICE_FIELDS,
  linesKey: 'line_items',
  linesDescription: 'The invoice’s lines in the order printed; an empty list when there are none.',
  lineFields: INVOICE_LINE_ITEM_FIELDS,
})

// Checks --------------------------------------------------------------------------------------

/** A1: on each line, quantity × unit_price = amount. Lines missing any of the three are left out. */
export function checkA1(v: InvoiceValues, tolerance: Decimal): CheckResult {
  return lineProductCheck('A1', v, tolerance)
}

/** A2: the line amounts sum to the subtotal. */
export function checkA2(v: InvoiceValues, tolerance: Decimal): CheckResult {
  return subtotalCheck('A2', v, tolerance)
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

/** D1: invoice_date is not in the future. */
export function checkD1(v: InvoiceValues, today: string): CheckResult {
  return dateCheck('D1', v, today, [{ name: 'invoice_date', label: 'invoice date', notFuture: true }])
}

/** D2: due_date ≥ invoice_date. */
export function checkD2(v: InvoiceValues, today: string): CheckResult {
  return dateCheck(
    'D2',
    v,
    today,
    [
      { name: 'invoice_date', label: 'invoice date' },
      { name: 'due_date', label: 'due date' },
    ],
    [['invoice_date', 'due_date']],
  )
}

/** U1's key: the vendor, by its tax id when printed and its name otherwise, and the invoice number (Lead ruling 1). */
export function invoiceDuplicateKey(v: InvoiceValues): DuplicateKey {
  const vendor = v.fields.vendor_tax_id ? 'vendor_tax_id' : 'vendor_name'
  return duplicateKey(
    'invoice',
    v,
    [
      { name: vendor, kind: 'text' },
      { name: 'invoice_number', kind: 'text' },
    ],
    'vendor and invoice number',
  )
}

/** Every invoice check, in order. */
export function invoiceChecks(v: InvoiceValues, c: CheckContext): CheckResult[] {
  return [
    checkA1(v, c.tolerance),
    checkA2(v, c.tolerance),
    checkA3(v, c.tolerance),
    checkA4(v, c.tolerance),
    checkD1(v, c.today),
    checkD2(v, c.today),
    checkU1(invoiceDuplicateKey(v), null),
  ]
}

export const INVOICE: DocTypeDef = {
  tool: RECORD_INVOICE,
  fields: INVOICE_FIELDS,
  linesKey: 'line_items',
  lineFields: INVOICE_LINE_ITEM_FIELDS,
  checks: invoiceChecks,
  duplicateKey: invoiceDuplicateKey,
  flagsCurrency: true,
}
