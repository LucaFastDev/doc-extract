import { describe, expect, it } from 'vitest'
import type { FieldRow } from '@shared/doctypes/fields'
import { normalise, scoreDocument, scoreRun, TARGETS, type ExpectedResult, type Extraction } from './score'

// The scoring (issue #43 criterion 3, PRD section 10, Lead rulings 3 and 4): per type, header
// fields and line-item cells apart, the share of expected values returned exactly after
// normalisation; an empty expected value is right only when the extraction is empty too.

const expected: ExpectedResult = {
  document: 'receipt-x.png',
  doc_type: 'receipt',
  fields: [
    { path: 'merchant_name', kind: 'text', value: 'Copper Kettle Deli' },
    { path: 'transaction_date', kind: 'date', value: '2026-09-05' },
    { path: 'tip', kind: 'amount', value: null },
    { path: 'total', kind: 'amount', value: '18.90' },
    { path: 'line_items[0].description', kind: 'text', value: 'Flat white' },
    { path: 'line_items[0].quantity', kind: 'number', value: '2' },
    { path: 'line_items[1].description', kind: 'text', value: 'Porridge' },
    { path: 'line_items[1].quantity', kind: 'number', value: '1' },
  ],
}

const row = (path: string, value: string | null, confidence = 0.95): FieldRow => ({
  path,
  kind: 'text',
  extracted_value: value,
  confidence,
  flags: [],
})

/** An extraction that returns every expected value, with some changed. */
function extraction(changes: Record<string, string | null> = {}, extra: FieldRow[] = []): Extraction {
  const fields = expected.fields.map((f) => row(f.path, f.path in changes ? changes[f.path] : f.value))
  return { outcome: 'ok', doc_type: 'receipt', fields: [...fields, ...extra] }
}

describe('normalise', () => {
  it('ignores the case and the surrounding whitespace of text, not the inner whitespace', () => {
    expect(normalise('text', '  Copper KETTLE deli ')).toBe(normalise('text', 'copper kettle Deli'))
    expect(normalise('text', 'Copper  Kettle')).not.toBe(normalise('text', 'Copper Kettle'))
  })

  it('reads a date as ISO 8601, padding the month and day and dropping a time', () => {
    expect(normalise('date', '2026-9-5')).toBe('2026-09-05')
    expect(normalise('date', ' 2026-09-05T00:00:00Z')).toBe('2026-09-05')
    expect(normalise('date', '05.09.2026')).not.toBe('2026-09-05')
  })

  it('reads amounts, numbers and percentages as decimals', () => {
    expect(normalise('amount', '18.9')).toBe(normalise('amount', '18.90'))
    expect(normalise('amount', '+0018.900')).toBe('18.9')
    expect(normalise('amount', '-0.00')).toBe('0')
    expect(normalise('amount', '1180')).toBe(normalise('amount', '1180.00'))
    expect(normalise('amount', '1,180.00')).not.toBe(normalise('amount', '1180.00'))
    expect(normalise('number', '2.0')).toBe('2')
    expect(normalise('percent', '19.00')).toBe('19')
    expect(normalise('amount', '-84.20')).not.toBe(normalise('amount', '84.20'))
  })

  it('gives null for an empty or blank value', () => {
    expect(normalise('text', '')).toBeNull()
    expect(normalise('amount', '   ')).toBeNull()
    expect(normalise('date', null)).toBeNull()
  })
})

describe('scoreDocument', () => {
  it('counts every value right when the extraction returns them, normalised', () => {
    const s = scoreDocument(
      expected,
      extraction({ merchant_name: ' COPPER KETTLE DELI', total: '18.9', transaction_date: '2026-9-5', tip: '' }),
    )
    expect(s.header).toEqual({ correct: 4, total: 4 })
    expect(s.line_items).toEqual({ correct: 4, total: 4 })
    expect(s.misses).toEqual([])
    expect(s.type_correct).toBe(true)
  })

  it('counts an empty expected value right only when the extraction is empty too', () => {
    const s = scoreDocument(expected, extraction({ tip: '1.50', total: null }))
    expect(s.header).toEqual({ correct: 2, total: 4 })
    expect(s.misses).toEqual([
      { path: 'tip', expected: null, got: '1.50', confidence: 0.95 },
      { path: 'total', expected: '18.90', got: null, confidence: 0.95 },
    ])
  })

  it('records each field’s confidence and counts the misses at or above 0.8 as confident', () => {
    const fields = expected.fields.map((f) =>
      f.path === 'total' ? row(f.path, '19.80', 0.8) : f.path === 'merchant_name' ? row(f.path, 'Copper Kettle', 0.5) : row(f.path, f.value),
    )
    const s = scoreDocument(expected, { outcome: 'ok', doc_type: 'receipt', fields })
    expect(s.confidence.total).toBe(0.8)
    expect(s.confidence.merchant_name).toBe(0.5)
    expect(s.confident_misses).toBe(1)
  })

  it('counts every cell of a missing line item as a miss, its empty cells too', () => {
    const fields = expected.fields.filter((f) => !f.path.startsWith('line_items[1]')).map((f) => row(f.path, f.value))
    const withEmpty: ExpectedResult = {
      ...expected,
      fields: [...expected.fields, { path: 'line_items[1].unit_price', kind: 'amount', value: null }],
    }
    const s = scoreDocument(withEmpty, { outcome: 'ok', doc_type: 'receipt', fields })
    expect(s.line_items).toEqual({ correct: 2, total: 5 })
    expect(s.misses.map((m) => m.path)).toEqual(['line_items[1].description', 'line_items[1].quantity', 'line_items[1].unit_price'])
    expect(s.misses.every((m) => m.got === null && m.confidence === null)).toBe(true)
  })

  it('compares line items by position', () => {
    const s = scoreDocument(
      expected,
      extraction({
        'line_items[0].description': 'Porridge',
        'line_items[0].quantity': '1',
        'line_items[1].description': 'Flat white',
        'line_items[1].quantity': '2',
      }),
    )
    expect(s.line_items).toEqual({ correct: 0, total: 4 })
  })

  it('lists an extra line item without scoring it', () => {
    const extra = [row('line_items[2].description', 'Muffin'), row('line_items[2].quantity', '1')]
    const s = scoreDocument(expected, extraction({}, extra))
    expect(s.line_items).toEqual({ correct: 4, total: 4 })
    expect(s.extra_line_items).toEqual([{ index: 2, values: { description: 'Muffin', quantity: '1' } }])
  })

  it('scores every expected value a miss when the detected type is wrong', () => {
    const s = scoreDocument(expected, { outcome: 'ok', doc_type: 'invoice', fields: [row('total', '18.90')] })
    expect(s.type_correct).toBe(false)
    expect(s.detected_type).toBe('invoice')
    expect(s.header).toEqual({ correct: 0, total: 4 })
    expect(s.line_items).toEqual({ correct: 0, total: 4 })
    expect(s.misses).toHaveLength(8)
    expect(s.misses.find((m) => m.path === 'tip')).toEqual({ path: 'tip', expected: null, got: null, confidence: null })
  })

  it('scores every expected value a miss when Claude calls record_not_supported', () => {
    const s = scoreDocument(expected, { outcome: 'not_supported', reason: 'A letter.' })
    expect(s.detected_type).toBe('not_supported')
    expect(s.type_correct).toBe(false)
    expect(s.header.correct + s.line_items.correct).toBe(0)
    expect(s.misses).toHaveLength(8)
  })

  it('scores every expected value a miss for a failed document and keeps its error', () => {
    const s = scoreDocument(expected, { outcome: 'failed', error: 'Claude was overloaded.' })
    expect(s.outcome).toBe('failed')
    expect(s.error).toBe('Claude was overloaded.')
    expect(s.detected_type).toBeNull()
    expect(s.type_correct).toBe(false)
    expect(s.header).toEqual({ correct: 0, total: 4 })
    expect(s.line_items).toEqual({ correct: 0, total: 4 })
  })
})

describe('scoreRun', () => {
  it('sums each type’s documents, header and line items apart, beside the PRD targets', () => {
    const good = scoreDocument(expected, extraction())
    const half = scoreDocument(expected, extraction({ total: '1', merchant_name: 'x', 'line_items[0].quantity': '3' }))
    const types = scoreRun([good, half])
    expect(types.receipt).toEqual({
      documents: 2,
      header: { correct: 6, total: 8, accuracy: 0.75, target: 0.92, meets_target: false },
      line_items: { correct: 7, total: 8, accuracy: 0.875, target: 0.85, meets_target: true },
      type_detection: { correct: 2, total: 2 },
    })
    expect(types.invoice).toBeUndefined()
  })

  it('holds the targets of PRD section 10', () => {
    expect(TARGETS).toEqual({
      invoice: { header: 0.95, line_items: 0.9 },
      receipt: { header: 0.92, line_items: 0.85 },
      bank_statement: { header: 0.95, line_items: 0.95 },
      purchase_order: { header: 0.95, line_items: 0.9 },
      delivery_note: { header: 0.95, line_items: 0.9 },
      quote: { header: 0.95, line_items: 0.9 },
    })
  })

  it('gives a null accuracy when a type has no line-item values to score', () => {
    const header = { ...expected, fields: expected.fields.filter((f) => !f.path.startsWith('line_items')) }
    const fields = header.fields.map((f) => row(f.path, f.value))
    const types = scoreRun([scoreDocument(header, { outcome: 'ok', doc_type: 'receipt', fields })])
    expect(types.receipt?.line_items).toEqual({ correct: 0, total: 0, accuracy: null, target: 0.85, meets_target: null })
  })
})
