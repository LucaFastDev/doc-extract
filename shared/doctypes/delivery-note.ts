import { formatNumber, subtract, type Decimal } from './decimal.ts'
import { dateCheck, linePath, lineSumCheck, type CheckContext } from './checks.ts'
import { checkU1, duplicateKey, type DuplicateKey } from './duplicate.ts'
import type { DocTypeDef } from './doctype.ts'
import { COMMON_FIELDS_WITHOUT_AMOUNTS, read, recordTool, type CheckResult, type DocumentValues, type FieldDef } from './fields.ts'

// The delivery note type (PRD section 4.1 Delivery note): its fields, its tool
// record_delivery_note, and its checks A1, A2, D1 and U1. It has no amounts: its currency may be
// empty and is never flagged (OQ-16), and its quantities are compared exactly, with no tolerance.

export const DELIVERY_NOTE_FIELDS: FieldDef[] = [
  ...COMMON_FIELDS_WITHOUT_AMOUNTS,
  { name: 'supplier_name', kind: 'text', description: 'The business delivering the goods (supplier, Lieferant, fournisseur).' },
  { name: 'customer_name', kind: 'text', description: 'The business receiving the goods (customer, Empfänger, client).' },
  { name: 'ship_to_address', kind: 'text', description: 'Where the goods are delivered (ship to, Lieferadresse, livré à).' },
  { name: 'delivery_note_number', kind: 'text', description: 'The delivery note number (delivery note no., Lieferschein-Nr., bon de livraison n°).' },
  { name: 'po_number', kind: 'text', description: 'The buyer’s purchase order number (PO, Bestellnummer), if printed.' },
  { name: 'carrier', kind: 'text', description: 'The carrier or shipping company, if printed.' },
  { name: 'tracking_number', kind: 'text', description: 'The shipment’s tracking number, if printed.' },
  { name: 'delivery_date', kind: 'date', description: 'The date of delivery or dispatch (delivery date, Lieferdatum, date de livraison).' },
  { name: 'total_packages', kind: 'number', description: 'The number of packages, parcels or pallets, if printed.' },
  { name: 'total_quantity', kind: 'number', description: 'The total quantity delivered, if printed.' },
]

export const DELIVERY_NOTE_LINE_ITEM_FIELDS: FieldDef[] = [
  { name: 'item_code', kind: 'text', description: 'The item or article code (SKU, Art.-Nr.), if printed.' },
  { name: 'description', kind: 'text', description: 'What was delivered, as printed.' },
  { name: 'quantity_ordered', kind: 'number', description: 'The quantity ordered, if printed.' },
  { name: 'quantity_delivered', kind: 'number', description: 'The quantity delivered (delivered, geliefert, livré).' },
  { name: 'unit', kind: 'text', description: 'The unit of the quantities, such as "pcs", "boxes" or "kg".' },
]

export const RECORD_DELIVERY_NOTE = recordTool({
  name: 'record_delivery_note',
  description:
    'Record the fields of a delivery note: a document that comes with delivered goods and lists what was shipped, usually without prices (delivery note, packing slip, Lieferschein, bon de livraison). Give every field; for one the document does not show, give an empty value. Read only what is printed and never invent a value.',
  fields: DELIVERY_NOTE_FIELDS,
  linesKey: 'line_items',
  linesDescription: 'The items delivered in the order printed; an empty list when there are none.',
  lineFields: DELIVERY_NOTE_LINE_ITEM_FIELDS,
})

// Checks --------------------------------------------------------------------------------------

const EXACT: Decimal = { units: 0n, scale: 0 }

/** A1: the quantities delivered sum to total_quantity, where printed. */
export function checkA1(v: DocumentValues): CheckResult {
  return lineSumCheck('A1', v, EXACT, {
    column: 'quantity_delivered',
    total: 'total_quantity',
    kind: 'number',
    columnLabel: 'quantity delivered',
    totalLabel: 'total quantity',
    lineLabel: 'line',
    linesLabel: 'quantities delivered',
  })
}

/**
 * A2: on each line, quantity_delivered ≤ quantity_ordered, where both are printed. A short or
 * over delivery is flagged for review, not taken as a misread (PRD 4.1).
 */
export function checkA2(v: DocumentValues): CheckResult {
  const all: string[] = []
  const checked: string[] = []
  const failed: string[] = []
  const problems: string[] = []

  v.line_items.forEach((line, i) => {
    const paths = [linePath(i, 'quantity_ordered'), linePath(i, 'quantity_delivered')]
    all.push(...paths)
    const ordered = read(line.quantity_ordered)
    const delivered = read(line.quantity_delivered)
    if (ordered.state === 'empty' || delivered.state === 'empty') return
    if (ordered.state === 'invalid' || delivered.state === 'invalid') {
      const [label, r] = ordered.state === 'invalid' ? ['quantity ordered', ordered] : ['quantity delivered', delivered]
      failed.push(...paths)
      problems.push(`Line ${i + 1}: ${label} "${(r as { text: string }).text}" is not a number`)
      return
    }
    if (subtract(delivered.value, ordered.value).units > 0n) {
      failed.push(...paths)
      problems.push(`Line ${i + 1}: ${formatNumber(delivered.value)} delivered, more than the ${formatNumber(ordered.value)} ordered`)
    } else {
      checked.push(...paths)
    }
  })

  if (problems.length > 0) return { check_id: 'A2', status: 'fail', field_paths: failed, message: problems.join('. ') }
  if (checked.length === 0) {
    return { check_id: 'A2', status: 'skipped', field_paths: all, message: 'Skipped: no line has both a quantity ordered and a quantity delivered.' }
  }
  return { check_id: 'A2', status: 'pass', field_paths: checked, message: null }
}

/** D1: delivery_date is not in the future. */
export function checkD1(v: DocumentValues, today: string): CheckResult {
  return dateCheck('D1', v, today, [{ name: 'delivery_date', label: 'delivery date', notFuture: true }])
}

/** U1's key: the supplier and the delivery note number. */
export function deliveryNoteDuplicateKey(v: DocumentValues): DuplicateKey {
  return duplicateKey(
    'delivery_note',
    v,
    [
      { name: 'supplier_name', kind: 'text' },
      { name: 'delivery_note_number', kind: 'text' },
    ],
    'supplier and delivery note number',
  )
}

export function deliveryNoteChecks(v: DocumentValues, c: CheckContext): CheckResult[] {
  return [checkA1(v), checkA2(v), checkD1(v, c.today), checkU1(deliveryNoteDuplicateKey(v), null)]
}

export const DELIVERY_NOTE: DocTypeDef = {
  tool: RECORD_DELIVERY_NOTE,
  fields: DELIVERY_NOTE_FIELDS,
  linesKey: 'line_items',
  lineFields: DELIVERY_NOTE_LINE_ITEM_FIELDS,
  checks: deliveryNoteChecks,
  duplicateKey: deliveryNoteDuplicateKey,
  flagsCurrency: false,
}
