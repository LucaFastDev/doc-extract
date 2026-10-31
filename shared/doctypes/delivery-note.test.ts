import { describe, expect, it } from 'vitest'
import {
  checkA1,
  checkA2,
  checkD1,
  DELIVERY_NOTE,
  DELIVERY_NOTE_FIELDS,
  DELIVERY_NOTE_LINE_ITEM_FIELDS,
  deliveryNoteChecks,
  deliveryNoteDuplicateKey,
} from './delivery-note'
import { parseDecimal, type Decimal } from './decimal'
import { checkU1 } from './duplicate'

// The delivery note type (PRD section 4.1 Delivery note): its fields and its checks A1, A2, D1
// and U1, each passing, failing with a message (US-4.1 AC-2), and skipped on empty inputs (OQ-43).
// It has no amounts, so the currency rule does not apply to it (OQ-16).

const TODAY = '2026-10-31'

const line = (quantity_ordered: string | null, quantity_delivered: string | null) => ({ quantity_ordered, quantity_delivered })
const LINES = [line('20', '20'), line('5', '5')]

const note = (fields: Record<string, string | null> = {}, lines: Record<string, string | null>[] = LINES) => ({
  fields: {
    supplier_name: 'Fictional Paper Co.',
    delivery_note_number: 'DN-5520',
    delivery_date: '2026-10-24',
    total_quantity: '25',
    ...fields,
  },
  line_items: lines,
})

describe('the delivery note field set', () => {
  it('has every field of PRD section 4.1 with its kind, plus the common fields', () => {
    expect(Object.fromEntries(DELIVERY_NOTE_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      language: 'text',
      currency: 'text',
      currency_as_printed: 'text',
      supplier_name: 'text',
      customer_name: 'text',
      ship_to_address: 'text',
      delivery_note_number: 'text',
      po_number: 'text',
      carrier: 'text',
      tracking_number: 'text',
      delivery_date: 'date',
      total_packages: 'number',
      total_quantity: 'number',
    })
    expect(Object.fromEntries(DELIVERY_NOTE_LINE_ITEM_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      item_code: 'text',
      description: 'text',
      quantity_ordered: 'number',
      quantity_delivered: 'number',
      unit: 'text',
    })
  })

  it('is not flagged for its currency, which may be empty', () => {
    expect(DELIVERY_NOTE.flagsCurrency).toBe(false)
    expect(DELIVERY_NOTE_FIELDS.find((f) => f.name === 'currency')?.description).toMatch(/empty/)
  })
})

describe('A1: sum of quantity_delivered = total_quantity, where printed', () => {
  it('passes when they match exactly', () => {
    expect(checkA1(note())).toEqual({
      check_id: 'A1',
      status: 'pass',
      field_paths: ['line_items[0].quantity_delivered', 'line_items[1].quantity_delivered', 'total_quantity'],
      message: null,
    })
  })

  it('fails saying both, with no tolerance on quantities', () => {
    expect(checkA1(note({ total_quantity: '24' }))).toMatchObject({ status: 'fail', message: 'Quantities delivered sum to 25; total quantity is 24' })
    expect(checkA1(note({ total_quantity: '25.01' })).status).toBe('fail')
  })

  it('is skipped with no total quantity printed, or a line without a delivered quantity', () => {
    expect(checkA1(note({ total_quantity: null }))).toMatchObject({ status: 'skipped', message: 'Skipped: no total quantity is printed.' })
    expect(checkA1(note({}, [line('20', null)]))).toMatchObject({ status: 'skipped', message: 'Skipped: line 1 has no quantity delivered.' })
  })
})

describe('A2: each line, quantity_delivered ≤ quantity_ordered, where both are printed', () => {
  it('passes for full and short deliveries', () => {
    expect(checkA2(note({}, [line('20', '20'), line('5', '3')]))).toMatchObject({ check_id: 'A2', status: 'pass' })
  })

  it('fails an over delivery, naming the line', () => {
    expect(checkA2(note({}, [line('20', '20'), line('5', '6')]))).toEqual({
      check_id: 'A2',
      status: 'fail',
      field_paths: ['line_items[1].quantity_ordered', 'line_items[1].quantity_delivered'],
      message: 'Line 2: 6 delivered, more than the 5 ordered',
    })
    expect(checkA2(note({}, [line('five', '5')])).message).toBe('Line 1: quantity ordered "five" is not a number')
  })

  it('is skipped when no line has both quantities', () => {
    expect(checkA2(note({}, [line(null, '20')]))).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no line has both a quantity ordered and a quantity delivered.',
    })
  })
})

describe('D1: delivery_date is not in the future', () => {
  it('passes, fails a future date, and is skipped with none', () => {
    expect(checkD1(note(), TODAY).status).toBe('pass')
    expect(checkD1(note({ delivery_date: '2026-12-24' }), TODAY).message).toBe('Delivery date 2026-12-24 is in the future')
    expect(checkD1(note({ delivery_date: null }), TODAY).status).toBe('skipped')
  })
})

describe('U1: same supplier and delivery_note_number', () => {
  it('passes, fails on a match, and is skipped without a number', () => {
    const key = deliveryNoteDuplicateKey(note())
    expect(key.key).toBe('delivery_note|fictionalpaperco|dn5520')
    expect(checkU1(key, null).status).toBe('pass')
    expect(checkU1(key, { file_name: 'DN-5520.pdf', by: 'key' }).message).toBe(
      'Duplicate of "DN-5520.pdf": the same supplier and delivery note number.',
    )
    expect(checkU1(deliveryNoteDuplicateKey(note({ delivery_note_number: null })), null).status).toBe('skipped')
  })
})

describe('deliveryNoteChecks', () => {
  it('runs A1, A2, D1 and U1, in order', () => {
    const tolerance = parseDecimal('0.01') as Decimal
    expect(deliveryNoteChecks(note(), { tolerance, today: TODAY }).map((c) => c.check_id)).toEqual(['A1', 'A2', 'D1', 'U1'])
  })
})
