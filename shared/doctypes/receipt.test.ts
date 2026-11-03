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

describe('A2 on a receipt: subtotal or total (2026-11-03)', () => {
  const lines = [line('2', '3.50', '7.00'), line('1', '2.80', '2.80')] // sum 9.80

  // One test for each case of the ruling, in its order.
  it('case 1: no line items is skipped', () => {
    expect(checkA2(receipt({}, []), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: there are no line items.' })
  })

  it('case 1: a line with no amount is skipped', () => {
    expect(checkA2(receipt({}, [line('2', '3.50', null), line('1', '2.80', '2.80')]), CENT)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: line 1 has no amount.',
    })
  })

  it('case 2: a printed subtotal that the lines match passes, whatever the total', () => {
    expect(checkA2(receipt({ subtotal: '9.80', total: '99.99' }, lines), CENT)).toMatchObject({ status: 'pass', message: null })
  })

  it('case 3: a printed total that the lines match passes, when the subtotal differs', () => {
    // Lines include VAT: 9.80 + 0.98 tax would be 10.78 on the total.
    const withVat = [line('2', '3.85', '7.70'), line('1', '3.08', '3.08')] // sum 10.78
    expect(checkA2(receipt({ subtotal: '9.80', tax_total: '0.98', tip: null, total: '10.78' }, withVat), CENT)).toMatchObject({
      status: 'pass',
      message: null,
    })
  })

  it('case 4: a printed subtotal that neither the lines nor the total match fails with the subtotal message', () => {
    expect(checkA2(receipt({ subtotal: '10.80', total: '12.00' }, lines), CENT)).toMatchObject({
      status: 'fail',
      message: 'Line items sum to 9.80; subtotal is 10.80',
    })
  })

  it('case 5: no subtotal, and a total the lines do not match, is skipped as today', () => {
    expect(checkA2(receipt({ subtotal: null, total: '11.78' }, lines), CENT)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no subtotal is printed.',
    })
  })

  it('case 6: neither a subtotal nor a total is skipped as today', () => {
    expect(checkA2(receipt({ subtotal: null, total: null }, lines), CENT)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no subtotal is printed.',
    })
  })

  it('case 7: an unreadable subtotal or line amount fails as today, even when the lines match the total', () => {
    expect(checkA2(receipt({ subtotal: '9,8x', total: '9.80' }, lines), CENT)).toMatchObject({
      status: 'fail',
      message: 'Subtotal "9,8x" is not an amount',
    })
    expect(checkA2(receipt({ total: '9.80' }, [line('2', '3.50', 'seven'), line('1', '2.80', '2.80')]), CENT)).toMatchObject({
      status: 'fail',
      message: 'Line 1: amount "seven" is not an amount',
    })
  })

  it('case 8: an unreadable total, with lines not matching a readable subtotal, fails with the subtotal message', () => {
    expect(checkA2(receipt({ subtotal: '10.80', total: 'n/a' }, lines), CENT)).toMatchObject({
      status: 'fail',
      message: 'Line items sum to 9.80; subtotal is 10.80',
    })
  })

  it('keeps the field paths: every line amount and the subtotal', () => {
    expect(checkA2(receipt({}, lines), CENT).field_paths).toEqual(['line_items[0].amount', 'line_items[1].amount', 'subtotal'])
  })

  it('passes with no subtotal printed when the lines match the printed total', () => {
    expect(checkA2(receipt({ subtotal: null, total: '9.80' }, lines), CENT)).toMatchObject({ status: 'pass', message: null })
  })

  it('reports the line amounts and the total as field paths on a pass by the total', () => {
    const withVat = [line('2', '3.85', '7.70'), line('1', '3.08', '3.08')] // sum 10.78
    const result = checkA2(receipt({ subtotal: '9.80', tax_total: '0.98', tip: null, total: '10.78' }, withVat), CENT)
    expect(result.status).toBe('pass')
    expect(result.field_paths).toEqual(['line_items[0].amount', 'line_items[1].amount', 'total'])
  })

  it('applies the tolerance to the match with the total', () => {
    const off = [line('1', '10.79', '10.79')]
    expect(checkA2(receipt({ subtotal: '9.80', total: '10.78' }, off), CENT).status).toBe('pass')
    expect(checkA2(receipt({ subtotal: '9.80', total: '10.70' }, off), CENT).status).toBe('fail')
  })
})

describe('A3: subtotal + tax_total + tip = total; a tip not printed counts as zero (2026-11-03)', () => {
  it('passes, and fails with the formula', () => {
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
  })

  it('passes with no tip printed when subtotal and tax add up to the total', () => {
    expect(checkA3(receipt({ tip: null, total: '10.78' }), CENT)).toEqual({
      check_id: 'A3',
      status: 'pass',
      field_paths: ['subtotal', 'tax_total', 'tip', 'total'],
      message: null,
    })
  })

  it('fails with no tip printed when they do not, and the message has no tip term', () => {
    expect(checkA3(receipt({ tip: null, total: '11.78' }), CENT)).toMatchObject({
      status: 'fail',
      field_paths: ['subtotal', 'tax_total', 'tip', 'total'],
      message: 'Subtotal 9.80 + tax 0.98 = 10.78; total is 11.78',
    })
  })

  it('is still skipped with no tax, no subtotal or no total printed', () => {
    expect(checkA3(receipt({ tax_total: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no tax is printed.' })
    expect(checkA3(receipt({ subtotal: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no subtotal is printed.' })
    expect(checkA3(receipt({ total: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no total is printed.' })
    expect(checkA3(receipt({ tip: null, tax_total: null }), CENT).status).toBe('skipped')
  })

  it('fails a tip that is printed but not an amount', () => {
    expect(checkA3(receipt({ tip: 'a lot' }), CENT)).toMatchObject({ status: 'fail', message: 'Tip "a lot" is not an amount' })
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
