import { describe, expect, it } from 'vitest'
import { parseDecimal, type Decimal } from './decimal'
import { amountTolerance } from './fields'
import {
  checkA1,
  checkA2,
  checkA3,
  checkA4,
  checkD1,
  checkD2,
  INVOICE_FIELDS,
  INVOICE_LINE_ITEM_FIELDS,
  invoiceChecks,
  invoiceDuplicateKey,
  RECORD_INVOICE,
  type InvoiceValues,
} from './invoice'
import { checkU1 } from './duplicate'

// The invoice type (PRD section 4.1 Invoice) and its checks: A1 to A4 (US-4.1 AC-1 to AC-4, OQ-7,
// OQ-43), D1 and D2 (OQ-6, Lead ruling 5 on #27) and U1 (OQ-9, Lead rulings 1 and 3 on #27).

const CENT = parseDecimal('0.01') as Decimal

function invoice(fields: Record<string, string | null> = {}, lines: Record<string, string | null>[] = []): InvoiceValues {
  return {
    fields: {
      subtotal: '1200.00',
      discount_total: '0.00',
      shipping: '0.00',
      tax_total: '240.00',
      total: '1440.00',
      amount_paid: '440.00',
      amount_due: '1000.00',
      currency: 'EUR',
      ...fields,
    },
    line_items: lines,
  }
}

const line = (quantity: string | null, unit_price: string | null, amount: string | null) => ({ quantity, unit_price, amount })

describe('the invoice field set', () => {
  it('has every field of PRD section 4.1 with its kind, plus the common fields', () => {
    const kinds = Object.fromEntries(INVOICE_FIELDS.map((f) => [f.name, f.kind]))
    expect(kinds).toEqual({
      language: 'text',
      currency: 'text',
      currency_as_printed: 'text',
      vendor_name: 'text',
      vendor_address: 'text',
      vendor_tax_id: 'text',
      customer_name: 'text',
      customer_address: 'text',
      customer_tax_id: 'text',
      invoice_number: 'text',
      purchase_order_number: 'text',
      payment_terms: 'text',
      invoice_date: 'date',
      due_date: 'date',
      subtotal: 'amount',
      tax_total: 'amount',
      shipping: 'amount',
      discount_total: 'amount',
      total: 'amount',
      amount_paid: 'amount',
      amount_due: 'amount',
    })
    expect(Object.fromEntries(INVOICE_LINE_ITEM_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      description: 'text',
      item_code: 'text',
      quantity: 'number',
      unit: 'text',
      unit_price: 'amount',
      tax_rate: 'percent',
      amount: 'amount',
    })
  })
})

describe('record_invoice', () => {
  const schema = RECORD_INVOICE.input_schema as {
    properties: Record<string, { type: string; properties?: Record<string, unknown>; items?: { properties: Record<string, unknown> } }>
    required: string[]
    additionalProperties: boolean
  }

  it('is a strict tool whose input has every field as { value, confidence }, all required', () => {
    expect(RECORD_INVOICE.name).toBe('record_invoice')
    expect(RECORD_INVOICE.strict).toBe(true)
    expect(RECORD_INVOICE.description).toMatch(/invoice/i)
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required.sort()).toEqual([...INVOICE_FIELDS.map((f) => f.name), 'line_items'].sort())
    expect(schema.properties.total).toMatchObject({
      type: 'object',
      properties: { value: { type: 'string' }, confidence: { type: 'number' } },
      required: ['value', 'confidence'],
      additionalProperties: false,
    })
    expect(schema.properties.line_items.type).toBe('array')
    expect(Object.keys(schema.properties.line_items.items!.properties).sort()).toEqual(
      INVOICE_LINE_ITEM_FIELDS.map((f) => f.name).sort(),
    )
  })

  it('stays inside strict mode’s limits: no union types, no optional parameters, no numeric or length constraints', () => {
    const json = JSON.stringify(RECORD_INVOICE.input_schema)
    for (const keyword of ['anyOf', 'oneOf', 'minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', '"type":["']) {
      expect(json, keyword).not.toContain(keyword)
    }
    const objects: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      const n = node as { type?: string; properties?: Record<string, unknown>; items?: unknown }
      if (n.type === 'object') objects.push(n)
      for (const child of Object.values(n.properties ?? {})) walk(child)
      walk(n.items)
    }
    walk(RECORD_INVOICE.input_schema)
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false)
      expect([...(o.required ?? [])].sort()).toEqual(Object.keys(o.properties ?? {}).sort())
    }
  })
})

describe('amountTolerance (OQ-7)', () => {
  it('is the configured tolerance, or 1 for a currency with no minor unit', () => {
    expect(amountTolerance('EUR', '0.01')).toEqual(parseDecimal('0.01'))
    expect(amountTolerance(null, '0.01')).toEqual(parseDecimal('0.01'))
    expect(amountTolerance('JPY', '0.01')).toEqual(parseDecimal('1'))
    expect(amountTolerance(' krw ', '0.01')).toEqual(parseDecimal('1'))
  })
})

describe('A1: each line, quantity × unit_price = amount', () => {
  it('passes when every complete line adds up, within the tolerance', () => {
    const result = checkA1(invoice({}, [line('3', '19.99', '59.97'), line('2', '10.005', '20.02')]), CENT)
    expect(result).toEqual({
      check_id: 'A1',
      status: 'pass',
      field_paths: [
        'line_items[0].quantity',
        'line_items[0].unit_price',
        'line_items[0].amount',
        'line_items[1].quantity',
        'line_items[1].unit_price',
        'line_items[1].amount',
      ],
      message: null,
    })
  })

  it('fails naming each line that does not add up, and flags only its fields', () => {
    const result = checkA1(invoice({}, [line('1', '5.00', '5.00'), line('3', '10.00', '25.00')]), CENT)
    expect(result).toEqual({
      check_id: 'A1',
      status: 'fail',
      field_paths: ['line_items[1].quantity', 'line_items[1].unit_price', 'line_items[1].amount'],
      message: 'Line 2: 3 × 10.00 = 30.00; amount is 25.00',
    })
  })

  it('is skipped when no line has a quantity, a unit price and an amount (OQ-43)', () => {
    expect(checkA1(invoice({}, []), CENT).status).toBe('skipped')
    expect(checkA1(invoice({}, [line(null, '10.00', '10.00'), line('1', null, '4.00')]), CENT)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no line has a quantity, a unit price and an amount.',
    })
  })

  it('checks the complete lines and leaves the incomplete ones out', () => {
    const result = checkA1(invoice({}, [line(null, '10.00', '99.00'), line('2', '5.00', '10.00')]), CENT)
    expect(result.status).toBe('pass')
    expect(result.field_paths).toEqual(['line_items[1].quantity', 'line_items[1].unit_price', 'line_items[1].amount'])
  })

  it('fails a value that is not a number, saying so', () => {
    const result = checkA1(invoice({}, [line('two', '5.00', '10.00')]), CENT)
    expect(result).toMatchObject({ status: 'fail', message: 'Line 1: quantity "two" is not a number' })
  })
})

describe('A2: sum of line amounts = subtotal', () => {
  it('passes within the tolerance', () => {
    const v = invoice({ subtotal: '1200.01' }, [line(null, null, '1000.00'), line(null, null, '200.00')])
    expect(checkA2(v, CENT)).toEqual({
      check_id: 'A2',
      status: 'pass',
      field_paths: ['line_items[0].amount', 'line_items[1].amount', 'subtotal'],
      message: null,
    })
  })

  it('fails with the PRD’s message when they differ', () => {
    const v = invoice({ subtotal: '1200.00' }, [line(null, null, '1000.00'), line(null, null, '180.00')])
    expect(checkA2(v, CENT)).toMatchObject({
      status: 'fail',
      field_paths: ['line_items[0].amount', 'line_items[1].amount', 'subtotal'],
      message: 'Line items sum to 1,180.00; subtotal is 1,200.00',
    })
  })

  it('is skipped with no subtotal, no lines, or a line without an amount (OQ-43)', () => {
    expect(checkA2(invoice({ subtotal: null }, [line(null, null, '1.00')]), CENT).status).toBe('skipped')
    expect(checkA2(invoice({}, []), CENT).status).toBe('skipped')
    expect(checkA2(invoice({}, [line(null, null, '1200.00'), line('1', '2', null)]), CENT).status).toBe('skipped')
  })
})

describe('A3: subtotal − discount_total + shipping + tax_total = total', () => {
  it('passes when it adds up', () => {
    expect(checkA3(invoice({ discount_total: '100.00', shipping: '20.00', total: '1360.00' }), CENT)).toEqual({
      check_id: 'A3',
      status: 'pass',
      field_paths: ['subtotal', 'discount_total', 'shipping', 'tax_total', 'total'],
      message: null,
    })
  })

  it('fails saying what did not add up', () => {
    expect(checkA3(invoice({ total: '1430.00' }), CENT)).toMatchObject({
      status: 'fail',
      field_paths: ['subtotal', 'discount_total', 'shipping', 'tax_total', 'total'],
      message: 'Subtotal 1,200.00 − discount 0.00 + shipping 0.00 + tax 240.00 = 1,440.00; total is 1,430.00',
    })
  })

  it('is skipped when any input is empty: no tax, discount or shipping printed (OQ-43, Lead ruling 4)', () => {
    for (const empty of ['subtotal', 'discount_total', 'shipping', 'tax_total', 'total']) {
      expect(checkA3(invoice({ [empty]: null }), CENT), empty).toMatchObject({ status: 'skipped' })
    }
  })

  it('treats amounts in a currency with no minor unit as equal within 1 (OQ-7)', () => {
    const yen = invoice({ currency: 'JPY', subtotal: '10000', discount_total: '0', shipping: '0', tax_total: '1000', total: '11001' })
    expect(checkA3(yen, amountTolerance('JPY', '0.01')).status).toBe('pass')
    expect(checkA3(yen, amountTolerance('EUR', '0.01')).status).toBe('fail')
  })
})

describe('A4: total − amount_paid = amount_due', () => {
  it('passes when it adds up', () => {
    expect(checkA4(invoice(), CENT)).toEqual({
      check_id: 'A4',
      status: 'pass',
      field_paths: ['total', 'amount_paid', 'amount_due'],
      message: null,
    })
  })

  it('fails saying what did not add up', () => {
    expect(checkA4(invoice({ amount_due: '900.00' }), CENT)).toMatchObject({
      status: 'fail',
      message: 'Total 1,440.00 − amount paid 440.00 = 1,000.00; amount due is 900.00',
    })
  })

  it('is skipped when an input is empty (OQ-43)', () => {
    expect(checkA4(invoice({ amount_paid: null }), CENT).status).toBe('skipped')
    expect(checkA4(invoice({ amount_due: '' }), CENT).status).toBe('skipped')
  })

  it('fails an amount that is not a number', () => {
    expect(checkA4(invoice({ total: '1.440,00' }), CENT)).toMatchObject({
      status: 'fail',
      message: 'Total "1.440,00" is not an amount',
    })
  })
})

const TODAY = '2026-10-31'

describe('D1: invoice_date is not in the future', () => {
  it('passes for a date up to one day after today (UTC)', () => {
    for (const invoice_date of ['2026-10-01', TODAY, '2026-11-01']) {
      expect(checkD1(invoice({ invoice_date }), TODAY), invoice_date).toEqual({
        check_id: 'D1',
        status: 'pass',
        field_paths: ['invoice_date'],
        message: null,
      })
    }
  })

  it('fails a date more than a day ahead, before 2000-01-01, or not a date (OQ-6)', () => {
    expect(checkD1(invoice({ invoice_date: '2026-11-02' }), TODAY)).toEqual({
      check_id: 'D1',
      status: 'fail',
      field_paths: ['invoice_date'],
      message: 'Invoice date 2026-11-02 is in the future',
    })
    expect(checkD1(invoice({ invoice_date: '1999-12-31' }), TODAY).message).toBe('Invoice date 1999-12-31 is before 2000-01-01')
    expect(checkD1(invoice({ invoice_date: '31/10/2026' }), TODAY).message).toBe('Invoice date "31/10/2026" is not a date')
    expect(checkD1(invoice({ invoice_date: '2026-02-30' }), TODAY).status).toBe('fail')
  })

  it('is skipped when no invoice date is printed (OQ-43)', () => {
    expect(checkD1(invoice({ invoice_date: null }), TODAY)).toEqual({
      check_id: 'D1',
      status: 'skipped',
      field_paths: ['invoice_date'],
      message: 'Skipped: no invoice date is printed.',
    })
  })
})

describe('D2: due_date ≥ invoice_date', () => {
  it('passes when the due date is on or after the invoice date, even in the future', () => {
    expect(checkD2(invoice({ invoice_date: '2026-10-01', due_date: '2026-10-01' }), TODAY).status).toBe('pass')
    expect(checkD2(invoice({ invoice_date: '2026-10-01', due_date: '2027-01-31' }), TODAY)).toEqual({
      check_id: 'D2',
      status: 'pass',
      field_paths: ['invoice_date', 'due_date'],
      message: null,
    })
  })

  it('fails a due date before the invoice date, saying both', () => {
    expect(checkD2(invoice({ invoice_date: '2026-10-01', due_date: '2026-09-30' }), TODAY)).toEqual({
      check_id: 'D2',
      status: 'fail',
      field_paths: ['invoice_date', 'due_date'],
      message: 'Due date 2026-09-30 is before invoice date 2026-10-01',
    })
  })

  it('checks the date that is printed when the other is not, and is skipped when neither is (Lead ruling 5)', () => {
    expect(checkD2(invoice({ invoice_date: null, due_date: '1998-01-01' }), TODAY)).toMatchObject({
      status: 'fail',
      message: 'Due date 1998-01-01 is before 2000-01-01',
    })
    expect(checkD2(invoice({ invoice_date: '2026-10-01', due_date: null }), TODAY).status).toBe('pass')
    expect(checkD2(invoice({ invoice_date: null, due_date: null }), TODAY)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: neither invoice date nor due date is printed.',
    })
  })
})

describe('U1: same vendor (tax id, else name) and invoice number', () => {
  const values = (fields: Record<string, string | null>) => invoice({ vendor_name: null, vendor_tax_id: null, invoice_number: null, ...fields })

  it('keys on the normalised tax id when printed, and the name otherwise (Lead ruling 1)', () => {
    expect(invoiceDuplicateKey(values({ vendor_name: 'Acme GmbH', vendor_tax_id: 'DE 123.456', invoice_number: 'INV-7' }))).toEqual({
      key: 'invoice|de123456|inv7',
      field_paths: ['vendor_tax_id', 'invoice_number'],
      flag_paths: ['vendor_tax_id', 'invoice_number'],
      label: 'vendor and invoice number',
    })
    expect(invoiceDuplicateKey(values({ vendor_name: 'ACME  GmbH', invoice_number: 'inv 7' })).key).toBe('invoice|acmegmbh|inv7')
  })

  it('passes with no earlier document; fails naming the earlier file and what matched', () => {
    const key = invoiceDuplicateKey(values({ vendor_name: 'Acme', invoice_number: 'INV-7' }))
    expect(checkU1(key, null)).toEqual({ check_id: 'U1', status: 'pass', field_paths: ['vendor_name', 'invoice_number'], message: null })
    expect(checkU1(key, { file_name: 'scan.pdf', by: 'key' })).toEqual({
      check_id: 'U1',
      status: 'fail',
      field_paths: ['vendor_name', 'invoice_number'],
      message: 'Duplicate of "scan.pdf": the same vendor and invoice number.',
    })
    expect(checkU1(key, { file_name: 'scan.pdf', by: 'file' }).message).toBe('Duplicate of "scan.pdf": the same file was uploaded before.')
  })

  it('is skipped when a key field is empty and no file matches (OQ-43)', () => {
    const key = invoiceDuplicateKey(values({ vendor_name: 'Acme' }))
    expect(key.key).toBeNull()
    expect(checkU1(key, null)).toEqual({
      check_id: 'U1',
      status: 'skipped',
      field_paths: ['vendor_name', 'invoice_number'],
      message: 'Skipped: the vendor and invoice number are not all printed, and no earlier upload is the same file.',
    })
    // The same file still fails it, flagging only the key fields that have a value (Lead ruling 3).
    expect(checkU1(key, { file_name: 'scan.pdf', by: 'file' }).field_paths).toEqual(['vendor_name'])
  })
})

describe('invoiceChecks', () => {
  it('runs A1 to A4, D1, D2 and U1, in order', () => {
    expect(invoiceChecks(invoice(), { tolerance: CENT, today: TODAY }).map((c) => c.check_id)).toEqual([
      'A1',
      'A2',
      'A3',
      'A4',
      'D1',
      'D2',
      'U1',
    ])
  })
})
