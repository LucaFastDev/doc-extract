import { describe, expect, it } from 'vitest'
import { DOC_TYPES, docTypeOfTool, prepareResult, RECORD_NOT_SUPPORTED, toolsFor } from './index'
import { INVOICE_FIELDS } from './invoice'

// From a tool call to the rows record_extraction stores (ARCHITECTURE.md section 6.3 steps 6 and
// 7): the input is validated against the type's schema again, normalised, flattened into one row
// per field and line-item cell, checked, and flagged (PRD US-2.1 AC-1 to AC-4, US-4.1 AC-2, OQ-8).

const CONFIG = { confidenceThreshold: 0.8, amountTolerance: '0.01' }

const f = (value: string, confidence = 0.95) => ({ value, confidence })

function invoiceInput(overrides: Record<string, unknown> = {}) {
  const fields = Object.fromEntries(INVOICE_FIELDS.map((d) => [d.name, f('')]))
  return {
    ...fields,
    vendor_name: f('Acme GmbH'),
    invoice_number: f(' INV-1042 '),
    currency: f('EUR'),
    subtotal: f('100.00'),
    discount_total: f('0.00'),
    shipping: f('0.00'),
    tax_total: f('19.00'),
    total: f('119.00'),
    line_items: [
      {
        description: f('Widgets'),
        item_code: f(''),
        quantity: f('4'),
        unit: f('pcs'),
        unit_price: f('25.00'),
        tax_rate: f('19'),
        amount: f('100.00', 0.5),
      },
    ],
    ...overrides,
  }
}

describe('the type registry', () => {
  it('has the invoice type in this milestone, and maps tool names to types', () => {
    expect(Object.keys(DOC_TYPES)).toEqual(['invoice'])
    expect(docTypeOfTool('record_invoice')).toBe('invoice')
    expect(docTypeOfTool('record_not_supported')).toBe('not_supported')
    expect(docTypeOfTool('record_receipt')).toBeNull()
  })

  it('sends every type’s tool and record_not_supported to detect, and only the chosen type’s tool otherwise', () => {
    expect(toolsFor(null).map((t) => t.name)).toEqual(['record_invoice', 'record_not_supported'])
    expect(toolsFor('invoice').map((t) => t.name)).toEqual(['record_invoice'])
    for (const tool of toolsFor(null)) expect(tool.strict).toBe(true)
  })

  it('record_not_supported takes a short reason', () => {
    expect(RECORD_NOT_SUPPORTED.input_schema).toEqual({
      type: 'object',
      properties: { reason: { type: 'string', description: expect.any(String) } },
      required: ['reason'],
      additionalProperties: false,
    })
  })
})

describe('prepareResult', () => {
  it('stores one row per field and line-item cell, empty values as null, text trimmed', () => {
    const result = prepareResult('invoice', invoiceInput(), CONFIG)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.fields).toHaveLength(INVOICE_FIELDS.length + 7)
    const byPath = Object.fromEntries(result.fields.map((r) => [r.path, r]))
    expect(byPath.invoice_number).toEqual({ path: 'invoice_number', kind: 'text', extracted_value: 'INV-1042', confidence: 0.95, flags: [] })
    expect(byPath.due_date).toMatchObject({ kind: 'date', extracted_value: null })
    expect(byPath['line_items[0].quantity']).toMatchObject({ kind: 'number', extracted_value: '4' })
    expect(byPath['line_items[0].tax_rate']).toMatchObject({ kind: 'percent', extracted_value: '19' })
  })

  it('flags a field whose confidence is below the threshold, and not one at it (OQ-8)', () => {
    const result = prepareResult('invoice', invoiceInput({ vendor_name: f('Acme', 0.79), customer_name: f('B', 0.8) }), CONFIG)
    if (!result.ok) throw new Error('invalid')
    const byPath = Object.fromEntries(result.fields.map((r) => [r.path, r]))
    expect(byPath.vendor_name.flags).toEqual(['low_confidence'])
    expect(byPath.customer_name.flags).toEqual([])
    expect(byPath['line_items[0].amount'].flags).toContain('low_confidence')
  })

  it('runs the checks and flags the fields a failed check names', () => {
    const result = prepareResult('invoice', invoiceInput({ total: f('120.00') }), CONFIG)
    if (!result.ok) throw new Error('invalid')
    const checks = Object.fromEntries(result.checks.map((c) => [c.check_id, c]))
    expect(checks.A1.status).toBe('pass')
    expect(checks.A2.status).toBe('pass')
    expect(checks.A3).toMatchObject({ status: 'fail', message: expect.stringContaining('total is 120.00') })
    expect(checks.A4.status).toBe('skipped')
    const flagged = result.fields.filter((r) => r.flags.includes('check_failed')).map((r) => r.path)
    expect(flagged.sort()).toEqual(['discount_total', 'shipping', 'subtotal', 'tax_total', 'total'])
  })

  it('reads the currency for the tolerance (OQ-7)', () => {
    const yen = invoiceInput({
      currency: f('JPY'),
      subtotal: f('1000'),
      tax_total: f('100'),
      total: f('1101'),
      discount_total: f('0'),
      shipping: f('0'),
      line_items: [],
    })
    const result = prepareResult('invoice', yen, CONFIG)
    if (!result.ok) throw new Error('invalid')
    expect(result.checks.find((c) => c.check_id === 'A3')?.status).toBe('pass')
  })

  it('refuses an input that does not match the schema, saying where', () => {
    const missing = invoiceInput()
    delete (missing as Record<string, unknown>).total
    const cases: [unknown, string][] = [
      [missing, 'total'],
      [invoiceInput({ total: { value: 119, confidence: 0.9 } }), 'total.value'],
      [invoiceInput({ total: f('119.00', 1.5) }), 'total.confidence'],
      [invoiceInput({ extra: f('x') }), 'extra'],
      [invoiceInput({ line_items: [{ amount: f('1') }] }), 'line_items[0]'],
      ['not an object', '(input)'],
    ]
    for (const [input, where] of cases) {
      const result = prepareResult('invoice', input, CONFIG)
      expect(result.ok, where).toBe(false)
      if (!result.ok) expect(result.errors.join('; '), where).toContain(where)
    }
  })
})
