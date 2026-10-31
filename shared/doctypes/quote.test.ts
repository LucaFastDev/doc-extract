import { describe, expect, it } from 'vitest'
import { parseDecimal, type Decimal } from './decimal'
import { checkU1 } from './duplicate'
import { amountTolerance } from './fields'
import { checkA1, checkA2, checkA3, checkD1, checkD2, QUOTE_FIELDS, QUOTE_LINE_ITEM_FIELDS, quoteChecks, quoteDuplicateKey } from './quote'

// The quote type (PRD section 4.1 Quote): its fields and its checks A1 to A3, D1, D2 and U1, each
// passing, failing with a message (US-4.1 AC-2), and skipped on empty inputs (OQ-43).

const CENT = parseDecimal('0.01') as Decimal
const TODAY = '2026-10-31'

const line = (quantity: string | null, unit_price: string | null, amount: string | null) => ({ quantity, unit_price, amount })
const LINES = [line('3', '400.00', '1200.00'), line('1', '350.00', '350.00')]

const quote = (fields: Record<string, string | null> = {}, lines: Record<string, string | null>[] = LINES) => ({
  fields: {
    supplier_name: 'Imaginary Builders AG',
    quote_number: 'Q-2026-118',
    quote_date: '2026-10-05',
    valid_until: '2026-11-04',
    subtotal: '1550.00',
    discount_total: '50.00',
    tax_total: '300.00',
    total: '1800.00',
    ...fields,
  },
  line_items: lines,
})

describe('the quote field set', () => {
  it('has every field of PRD section 4.1 with its kind, plus the common fields', () => {
    expect(Object.fromEntries(QUOTE_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      language: 'text',
      currency: 'text',
      currency_as_printed: 'text',
      supplier_name: 'text',
      supplier_address: 'text',
      customer_name: 'text',
      customer_address: 'text',
      quote_number: 'text',
      payment_terms: 'text',
      quote_date: 'date',
      valid_until: 'date',
      subtotal: 'amount',
      discount_total: 'amount',
      tax_total: 'amount',
      total: 'amount',
    })
    expect(Object.fromEntries(QUOTE_LINE_ITEM_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      description: 'text',
      item_code: 'text',
      quantity: 'number',
      unit: 'text',
      unit_price: 'amount',
      amount: 'amount',
    })
  })
})

describe('A1: each line, quantity × unit_price = amount', () => {
  it('passes, fails naming the line, and is skipped with no complete line', () => {
    expect(checkA1(quote(), CENT).status).toBe('pass')
    expect(checkA1(quote({}, [line('3', '400.00', '1100.00')]), CENT).message).toBe('Line 1: 3 × 400.00 = 1,200.00; amount is 1,100.00')
    expect(checkA1(quote({}, []), CENT).status).toBe('skipped')
  })
})

describe('A2: sum of line amounts = subtotal', () => {
  it('passes, fails saying both sums, and is skipped with no subtotal', () => {
    expect(checkA2(quote(), CENT).status).toBe('pass')
    expect(checkA2(quote({ subtotal: '1500.00' }), CENT).message).toBe('Line items sum to 1,550.00; subtotal is 1,500.00')
    expect(checkA2(quote({ subtotal: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no subtotal is printed.' })
  })
})

describe('A3: subtotal − discount_total + tax_total = total', () => {
  it('passes, fails with the formula, and is skipped with no discount printed', () => {
    expect(checkA3(quote(), CENT)).toEqual({
      check_id: 'A3',
      status: 'pass',
      field_paths: ['subtotal', 'discount_total', 'tax_total', 'total'],
      message: null,
    })
    expect(checkA3(quote({ total: '1850.00' }), CENT).message).toBe('Subtotal 1,550.00 − discount 50.00 + tax 300.00 = 1,800.00; total is 1,850.00')
    expect(checkA3(quote({ discount_total: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no discount is printed.' })
  })

  it('treats amounts in a currency with no minor unit as equal within 1 (OQ-7)', () => {
    const yen = quote({ subtotal: '155000', discount_total: '5000', tax_total: '30000', total: '180001' })
    expect(checkA3(yen, amountTolerance('JPY', '0.01')).status).toBe('pass')
    expect(checkA3(yen, CENT).status).toBe('fail')
  })
})

describe('D1: quote_date is not in the future', () => {
  it('passes, fails a future date, and is skipped with none', () => {
    expect(checkD1(quote(), TODAY).status).toBe('pass')
    expect(checkD1(quote({ quote_date: '2026-11-05' }), TODAY).message).toBe('Quote date 2026-11-05 is in the future')
    expect(checkD1(quote({ quote_date: null }), TODAY).status).toBe('skipped')
  })
})

describe('D2: valid_until ≥ quote_date', () => {
  it('passes with a validity in the future, fails one before the quote date, and is skipped with neither', () => {
    expect(checkD2(quote(), TODAY)).toMatchObject({ status: 'pass', field_paths: ['quote_date', 'valid_until'] })
    expect(checkD2(quote({ valid_until: '2026-10-01' }), TODAY).message).toBe('Valid until 2026-10-01 is before quote date 2026-10-05')
    expect(checkD2(quote({ quote_date: null, valid_until: null }), TODAY)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: neither quote date nor valid until is printed.',
    })
  })
})

describe('U1: same supplier and quote_number', () => {
  it('passes, fails on a match, and is skipped without a supplier', () => {
    const key = quoteDuplicateKey(quote())
    expect(key.key).toBe('quote|imaginarybuildersag|q2026118')
    expect(checkU1(key, null).status).toBe('pass')
    expect(checkU1(key, { file_name: 'Angebot.pdf', by: 'key' }).message).toBe('Duplicate of "Angebot.pdf": the same supplier and quote number.')
    expect(checkU1(quoteDuplicateKey(quote({ supplier_name: null })), null).status).toBe('skipped')
  })
})

describe('quoteChecks', () => {
  it('runs A1 to A3, D1, D2 and U1, in order', () => {
    expect(quoteChecks(quote(), { tolerance: CENT, today: TODAY }).map((c) => c.check_id)).toEqual(['A1', 'A2', 'A3', 'D1', 'D2', 'U1'])
  })
})
