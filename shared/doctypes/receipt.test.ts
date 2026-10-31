import { describe, expect, it } from 'vitest'
import { parseDecimal, type Decimal } from './decimal'
import { checkU1 } from './duplicate'
import { checkA1, checkA2, checkA3, checkD1, RECEIPT_FIELDS, RECEIPT_LINE_ITEM_FIELDS, receiptChecks, receiptDuplicateKey } from './receipt'

// The receipt type (PRD section 4.1 Receipt): its fields and its checks A1 to A3, D1 and U1, each
// passing, failing with a message saying what did not add up (US-4.1 AC-2), and skipped on empty
// inputs (OQ-43).

const CENT = parseDecimal('0.01') as Decimal
const TODAY = '2026-10-31'

const receipt = (fields: Record<string, string | null> = {}, lines: Record<string, string | null>[] = []) => ({
  fields: {
    merchant_name: 'Lantern Street Café',
    transaction_date: '2026-10-20',
    transaction_time: '08:42',
    subtotal: '9.80',
    tax_total: '0.98',
    tip: '1.00',
    total: '11.78',
    ...fields,
  },
  line_items: lines,
})
const line = (quantity: string | null, unit_price: string | null, amount: string | null) => ({ quantity, unit_price, amount })

describe('the receipt field set', () => {
  it('has every field of PRD section 4.1 with its kind, plus the common fields', () => {
    expect(Object.fromEntries(RECEIPT_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      language: 'text',
      currency: 'text',
      currency_as_printed: 'text',
      merchant_name: 'text',
      merchant_address: 'text',
      merchant_tax_id: 'text',
      receipt_number: 'text',
      payment_method: 'text',
      card_last4: 'text',
      transaction_date: 'date',
      transaction_time: 'text',
      subtotal: 'amount',
      tax_total: 'amount',
      tip: 'amount',
      total: 'amount',
    })
    expect(Object.fromEntries(RECEIPT_LINE_ITEM_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      description: 'text',
      quantity: 'number',
      unit_price: 'amount',
      amount: 'amount',
    })
  })
})

describe('A1: each line, quantity × unit_price = amount', () => {
  it('passes, fails naming the line, and is skipped with no complete line', () => {
    expect(checkA1(receipt({}, [line('2', '3.50', '7.00')]), CENT)).toMatchObject({ check_id: 'A1', status: 'pass' })
    expect(checkA1(receipt({}, [line('2', '3.50', '6.00')]), CENT)).toMatchObject({
      status: 'fail',
      field_paths: ['line_items[0].quantity', 'line_items[0].unit_price', 'line_items[0].amount'],
      message: 'Line 1: 2 × 3.50 = 7.00; amount is 6.00',
    })
    expect(checkA1(receipt({}, [line(null, '3.50', '7.00')]), CENT).status).toBe('skipped')
  })
})

describe('A2: sum of line amounts = subtotal', () => {
  it('passes, fails saying both sums, and is skipped with no lines or no subtotal', () => {
    const lines = [line('2', '3.50', '7.00'), line('1', '2.80', '2.80')]
    expect(checkA2(receipt({}, lines), CENT)).toMatchObject({ check_id: 'A2', status: 'pass' })
    expect(checkA2(receipt({ subtotal: '10.80' }, lines), CENT)).toMatchObject({
      status: 'fail',
      message: 'Line items sum to 9.80; subtotal is 10.80',
    })
    expect(checkA2(receipt({}, []), CENT).status).toBe('skipped')
    expect(checkA2(receipt({ subtotal: null }, lines), CENT).status).toBe('skipped')
  })
})

describe('A3: subtotal + tax_total + tip = total', () => {
  it('passes, fails with the formula, and is skipped when no tip is printed', () => {
    expect(checkA3(receipt(), CENT)).toEqual({
      check_id: 'A3',
      status: 'pass',
      field_paths: ['subtotal', 'tax_total', 'tip', 'total'],
      message: null,
    })
    expect(checkA3(receipt({ total: '10.78' }), CENT)).toMatchObject({
      status: 'fail',
      message: 'Subtotal 9.80 + tax 0.98 + tip 1.00 = 11.78; total is 10.78',
    })
    expect(checkA3(receipt({ tip: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no tip is printed.' })
  })
})

describe('D1: transaction_date is not in the future', () => {
  it('passes, fails a future or pre-2000 date, and is skipped with none', () => {
    expect(checkD1(receipt(), TODAY)).toMatchObject({ check_id: 'D1', status: 'pass', field_paths: ['transaction_date'] })
    expect(checkD1(receipt({ transaction_date: '2026-11-03' }), TODAY)).toMatchObject({
      status: 'fail',
      message: 'Transaction date 2026-11-03 is in the future',
    })
    expect(checkD1(receipt({ transaction_date: '1999-06-01' }), TODAY).message).toBe('Transaction date 1999-06-01 is before 2000-01-01')
    expect(checkD1(receipt({ transaction_date: null }), TODAY)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no transaction date is printed.',
    })
  })
})

describe('U1: same merchant, transaction date, time and total', () => {
  it('keys on all four, normalised', () => {
    expect(receiptDuplicateKey(receipt({ merchant_name: 'LANTERN street café', total: '11.780' })).key).toBe(
      'receipt|lanternstreetcafé|20261020|0842|11.78',
    )
  })

  it('passes, fails on a match, and is skipped when a key field is empty', () => {
    const key = receiptDuplicateKey(receipt())
    expect(checkU1(key, null)).toMatchObject({ status: 'pass', field_paths: ['merchant_name', 'transaction_date', 'transaction_time', 'total'] })
    expect(checkU1(key, { file_name: 'IMG_0042.jpg', by: 'key' }).message).toBe(
      'Duplicate of "IMG_0042.jpg": the same merchant, transaction date, time and total.',
    )
    const partial = receiptDuplicateKey(receipt({ transaction_time: null }))
    expect(checkU1(partial, null).status).toBe('skipped')
    expect(checkU1(partial, { file_name: 'IMG_0042.jpg', by: 'file' }).field_paths).toEqual(['merchant_name', 'transaction_date', 'total'])
  })
})

describe('receiptChecks', () => {
  it('runs A1 to A3, D1 and U1, in order', () => {
    expect(receiptChecks(receipt(), { tolerance: CENT, today: TODAY }).map((c) => c.check_id)).toEqual(['A1', 'A2', 'A3', 'D1', 'U1'])
  })
})
