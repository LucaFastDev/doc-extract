import { describe, expect, it } from 'vitest'
import { DOC_TYPES } from './index'
import { currentValue, documentValues, listChecks, parseLinePath, recheck, type StoredField } from './review'

// The checks again on corrected values (PRD US-4.1 AC-7, OQ-44), shared by the review screen and
// approve-document: the values the checks read, the flags they give, and how failed checks are
// named.

const cell = (path: string, extracted: string | null, corrected: string | null = null, flags: string[] = []): StoredField => ({
  path,
  kind: 'text',
  extracted_value: extracted,
  corrected_value: corrected,
  confidence: 0.9,
  flags,
})

describe('the values the checks read', () => {
  it('take the correction over the extracted value, and an emptied field as empty', () => {
    expect(currentValue(cell('total', '1.00', '2.00'))).toBe('2.00')
    expect(currentValue(cell('total', '1.00'))).toBe('1.00')
    expect(currentValue(cell('total', '1.00', ''))).toBe('')
    const values = documentValues(DOC_TYPES.receipt, [cell('total', '1.00', ''), cell('merchant_name', ' Café ')])
    expect(values.fields.total).toBeNull()
    expect(values.fields.merchant_name).toBe('Café')
    // Every field of the type is there, empty ones as null.
    expect(Object.keys(values.fields)).toEqual(DOC_TYPES.receipt.fields.map((f) => f.name))
  })

  it('put line cells in their lines, by index, with every cell of the type', () => {
    expect(parseLinePath('line_items[12].unit_price')).toEqual({ index: 12, name: 'unit_price' })
    expect(parseLinePath('subtotal')).toBeNull()
    const values = documentValues(DOC_TYPES.receipt, [cell('line_items[1].amount', '2.00'), cell('line_items[0].amount', '1.00', '1.50')])
    expect(values.line_items).toEqual([
      { description: null, quantity: null, unit_price: null, amount: '1.50' },
      { description: null, quantity: null, unit_price: null, amount: '2.00' },
    ])
  })
})

describe('recheck', () => {
  it('runs the type’s checks and flags the rows a failed check names, keeping low confidence', () => {
    const rows = [
      { ...cell('subtotal', '10.00', null, ['low_confidence']), kind: 'amount' as const },
      { ...cell('line_items[0].amount', '9.00'), kind: 'amount' as const },
      cell('currency', 'EUR'),
      cell('currency_as_printed', 'EUR'),
    ]
    const result = recheck(DOC_TYPES.receipt, rows, { amountTolerance: '0.01', today: '2026-10-31' })
    expect(result.checks.find((c) => c.check_id === 'A2')).toMatchObject({ status: 'fail' })
    expect(result.flags.subtotal).toEqual(['low_confidence', 'check_failed'])
    expect(result.flags.currency).toEqual([])
  })
})

describe('listChecks', () => {
  it('joins check ids for a message', () => {
    expect(listChecks(['A2'])).toBe('A2')
    expect(listChecks(['A2', 'U1'])).toBe('A2 and U1')
    expect(listChecks(['A1', 'A2', 'U1'])).toBe('A1, A2 and U1')
  })
})
