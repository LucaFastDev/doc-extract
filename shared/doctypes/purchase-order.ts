import type { Decimal } from './decimal.ts'
import { dateCheck, formulaCheck, lineProductCheck, subtotalCheck, type CheckContext } from './checks.ts'
import { checkU1, duplicateKey, type DuplicateKey } from './duplicate.ts'
import type { DocTypeDef } from './doctype.ts'
import { COMMON_FIELDS, recordTool, type CheckResult, type DocumentValues, type FieldDef } from './fields.ts'

// The purchase order type (PRD section 4.1 Purchase order): its fields, its tool
// record_purchase_order, and its checks A1 to A3, D1, D2 and U1.

export const PURCHASE_ORDER_FIELDS: FieldDef[] = [
  ...COMMON_FIELDS,
  { name: 'buyer_name', kind: 'text', description: 'The business placing the order (buyer, Besteller, acheteur).' },
  { name: 'buyer_address', kind: 'text', description: 'The buyer’s postal address, as printed.' },
  { name: 'supplier_name', kind: 'text', description: 'The business the order is sent to (supplier, vendor, Lieferant, fournisseur).' },
  { name: 'supplier_address', kind: 'text', description: 'The supplier’s postal address, as printed.' },
  { name: 'ship_to_address', kind: 'text', description: 'Where the goods are to be delivered (ship to, Lieferadresse, livrer à), if printed.' },
  { name: 'po_number', kind: 'text', description: 'The purchase order number (PO no., Bestellnummer, numéro de commande).' },
  { name: 'payment_terms', kind: 'text', description: 'The payment terms as printed, such as "Net 30".' },
  { name: 'order_date', kind: 'date', description: 'The date of the order (order date, Bestelldatum, date de commande).' },
  { name: 'requested_delivery_date', kind: 'date', description: 'The date the goods are wanted by (delivery date, Liefertermin), if printed.' },
  { name: 'subtotal', kind: 'amount', description: 'The total before tax and shipping (subtotal, net, Zwischensumme).' },
  { name: 'tax_total', kind: 'amount', description: 'The total tax (VAT, sales tax, MwSt, TVA).' },
  { name: 'shipping', kind: 'amount', description: 'Shipping or delivery charges (Versand, frais de port).' },
  { name: 'total', kind: 'amount', description: 'The order total including tax (total, Gesamtbetrag).' },
]

export const PURCHASE_ORDER_LINE_ITEM_FIELDS: FieldDef[] = [
  { name: 'item_code', kind: 'text', description: 'The item or article code (SKU, Art.-Nr.), if printed.' },
  { name: 'description', kind: 'text', description: 'What is ordered, as printed.' },
  { name: 'quantity', kind: 'number', description: 'The quantity ordered (qty, Menge, quantité).' },
  { name: 'unit', kind: 'text', description: 'The unit of the quantity, such as "pcs", "h" or "kg".' },
  { name: 'unit_price', kind: 'amount', description: 'The price of one unit (unit price, Einzelpreis, prix unitaire).' },
  { name: 'amount', kind: 'amount', description: 'The line total (amount, Betrag, montant).' },
]

export const RECORD_PURCHASE_ORDER = recordTool({
  name: 'record_purchase_order',
  description:
    'Record the fields of a purchase order: a buyer’s order to a supplier for goods or services, with a PO number, an order date, the items ordered and their prices. Give every field; for one the document does not show, give an empty value. Read only what is printed and never invent a value.',
  fields: PURCHASE_ORDER_FIELDS,
  linesKey: 'line_items',
  linesDescription: 'The items ordered in the order printed; an empty list when there are none.',
  lineFields: PURCHASE_ORDER_LINE_ITEM_FIELDS,
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

/** A3: subtotal + shipping + tax_total = total. */
export function checkA3(v: DocumentValues, tolerance: Decimal): CheckResult {
  return formulaCheck(
    'A3',
    v,
    tolerance,
    { name: 'subtotal', label: 'subtotal' },
    [
      { name: 'shipping', label: 'shipping', sign: '+' },
      { name: 'tax_total', label: 'tax', sign: '+' },
    ],
    { name: 'total', label: 'total' },
  )
}

/** D1: order_date is not in the future. */
export function checkD1(v: DocumentValues, today: string): CheckResult {
  return dateCheck('D1', v, today, [{ name: 'order_date', label: 'order date', notFuture: true }])
}

/** D2: requested_delivery_date ≥ order_date. */
export function checkD2(v: DocumentValues, today: string): CheckResult {
  return dateCheck(
    'D2',
    v,
    today,
    [
      { name: 'order_date', label: 'order date' },
      { name: 'requested_delivery_date', label: 'requested delivery date' },
    ],
    [['order_date', 'requested_delivery_date']],
  )
}

/** U1's key: the buyer and the PO number. */
export function purchaseOrderDuplicateKey(v: DocumentValues): DuplicateKey {
  return duplicateKey(
    'purchase_order',
    v,
    [
      { name: 'buyer_name', kind: 'text' },
      { name: 'po_number', kind: 'text' },
    ],
    'buyer and PO number',
  )
}

export function purchaseOrderChecks(v: DocumentValues, c: CheckContext): CheckResult[] {
  return [
    checkA1(v, c.tolerance),
    checkA2(v, c.tolerance),
    checkA3(v, c.tolerance),
    checkD1(v, c.today),
    checkD2(v, c.today),
    checkU1(purchaseOrderDuplicateKey(v), null),
  ]
}

export const PURCHASE_ORDER: DocTypeDef = {
  tool: RECORD_PURCHASE_ORDER,
  fields: PURCHASE_ORDER_FIELDS,
  linesKey: 'line_items',
  lineFields: PURCHASE_ORDER_LINE_ITEM_FIELDS,
  checks: purchaseOrderChecks,
  duplicateKey: purchaseOrderDuplicateKey,
  flagsCurrency: true,
}
