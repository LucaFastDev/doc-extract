import { describe, expect, it } from 'vitest'
import { parseDecimal, type Decimal } from './decimal'
import { checkU1 } from './duplicate'
import {
  checkA1,
  checkA2,
  checkA3,
  checkD1,
  checkD2,
  PURCHASE_ORDER_FIELDS,
  PURCHASE_ORDER_LINE_ITEM_FIELDS,
  purchaseOrderChecks,
  purchaseOrderDuplicateKey,
} from './purchase-order'

// The purchase order type (PRD section 4.1 Purchase order): its fields and its checks A1 to A3,
// D1, D2 and U1, each passing, failing with a message (US-4.1 AC-2), and skipped on empty inputs
// (OQ-43).

const CENT = parseDecimal('0.01') as Decimal
const TODAY = '2026-10-31'

const line = (quantity: string | null, unit_price: string | null, amount: string | null) => ({ quantity, unit_price, amount })
const LINES = [line('20', '24.00', '480.00'), line('5', '60.00', '300.00')]

const order = (fields: Record<string, string | null> = {}, lines: Record<string, string | null>[] = LINES) => ({
  fields: {
    buyer_name: 'Example Studio Ltd',
    po_number: 'PO-7731',
    order_date: '2026-10-12',
    requested_delivery_date: '2026-10-26',
    subtotal: '780.00',
    shipping: '20.00',
    tax_total: '160.00',
    total: '960.00',
    ...fields,
  },
  line_items: lines,
})

describe('the purchase order field set', () => {
  it('has every field of PRD section 4.1 with its kind, plus the common fields', () => {
    expect(Object.fromEntries(PURCHASE_ORDER_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      language: 'text',
      currency: 'text',
      currency_as_printed: 'text',
      buyer_name: 'text',
      buyer_address: 'text',
      supplier_name: 'text',
      supplier_address: 'text',
      ship_to_address: 'text',
      po_number: 'text',
      payment_terms: 'text',
      order_date: 'date',
      requested_delivery_date: 'date',
      subtotal: 'amount',
      tax_total: 'amount',
      shipping: 'amount',
      total: 'amount',
    })
    expect(Object.fromEntries(PURCHASE_ORDER_LINE_ITEM_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      item_code: 'text',
      description: 'text',
      quantity: 'number',
      unit: 'text',
      unit_price: 'amount',
      amount: 'amount',
    })
  })
})

describe('A1: each line, quantity × unit_price = amount', () => {
  it('passes, fails naming the line, and is skipped with no complete line', () => {
    expect(checkA1(order(), CENT).status).toBe('pass')
    expect(checkA1(order({}, [line('20', '24.00', '420.00')]), CENT).message).toBe('Line 1: 20 × 24.00 = 480.00; amount is 420.00')
    expect(checkA1(order({}, [line('20', null, '480.00')]), CENT).status).toBe('skipped')
  })
})

describe('A2: sum of line amounts = subtotal', () => {
  it('passes, fails saying both sums, and is skipped with no lines', () => {
    expect(checkA2(order(), CENT).status).toBe('pass')
    expect(checkA2(order({ subtotal: '800.00' }), CENT).message).toBe('Line items sum to 780.00; subtotal is 800.00')
    expect(checkA2(order({}, []), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: there are no line items.' })
  })
})

describe('A3: subtotal + shipping + tax_total = total', () => {
  it('passes, fails with the formula, and is skipped with no shipping printed', () => {
    expect(checkA3(order(), CENT)).toEqual({
      check_id: 'A3',
      status: 'pass',
      field_paths: ['subtotal', 'shipping', 'tax_total', 'total'],
      message: null,
    })
    expect(checkA3(order({ total: '940.00' }), CENT).message).toBe('Subtotal 780.00 + shipping 20.00 + tax 160.00 = 960.00; total is 940.00')
    expect(checkA3(order({ shipping: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no shipping is printed.' })
  })
})

describe('D1: order_date is not in the future', () => {
  it('passes, fails a future date, and is skipped with none', () => {
    expect(checkD1(order(), TODAY).status).toBe('pass')
    expect(checkD1(order({ order_date: '2027-01-01' }), TODAY).message).toBe('Order date 2027-01-01 is in the future')
    expect(checkD1(order({ order_date: null }), TODAY)).toMatchObject({ status: 'skipped', message: 'Skipped: no order date is printed.' })
  })
})

describe('D2: requested_delivery_date ≥ order_date', () => {
  it('passes, fails a delivery date before the order, and is skipped with neither', () => {
    expect(checkD2(order(), TODAY)).toMatchObject({ status: 'pass', field_paths: ['order_date', 'requested_delivery_date'] })
    expect(checkD2(order({ requested_delivery_date: '2026-10-01' }), TODAY).message).toBe(
      'Requested delivery date 2026-10-01 is before order date 2026-10-12',
    )
    expect(checkD2(order({ order_date: null, requested_delivery_date: null }), TODAY).status).toBe('skipped')
  })
})

describe('U1: same buyer and po_number', () => {
  it('passes, fails on a match, and is skipped without a PO number', () => {
    const key = purchaseOrderDuplicateKey(order())
    expect(key.key).toBe('purchase_order|examplestudioltd|po7731')
    expect(checkU1(key, null)).toMatchObject({ status: 'pass', field_paths: ['buyer_name', 'po_number'] })
    expect(checkU1(key, { file_name: 'PO-7731.pdf', by: 'key' }).message).toBe('Duplicate of "PO-7731.pdf": the same buyer and PO number.')
    expect(checkU1(purchaseOrderDuplicateKey(order({ po_number: null })), null).status).toBe('skipped')
  })
})

describe('purchaseOrderChecks', () => {
  it('runs A1 to A3, D1, D2 and U1, in order', () => {
    expect(purchaseOrderChecks(order(), { tolerance: CENT, today: TODAY }).map((c) => c.check_id)).toEqual(['A1', 'A2', 'A3', 'D1', 'D2', 'U1'])
  })
})
