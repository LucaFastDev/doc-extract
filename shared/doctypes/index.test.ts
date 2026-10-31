import { describe, expect, it } from 'vitest'
import { DOC_TYPES, docTypeOfTool, prepareResult, RECORD_NOT_SUPPORTED, toolsFor, type DocType } from './index'
import { INVOICE_FIELDS } from './invoice'

// From a tool call to the rows record_extraction stores (ARCHITECTURE.md section 6.3 steps 6 and
// 7): the input is validated against the type's schema again, normalised, flattened into one row
// per field and line-item cell, checked, and flagged (PRD US-2.1 AC-1 to AC-4, US-4.1 AC-2, OQ-8).

const CONFIG = { confidenceThreshold: 0.8, amountTolerance: '0.01', today: '2026-10-31' }

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

const TYPES = ['invoice', 'receipt', 'bank_statement', 'purchase_order', 'delivery_note', 'quote'] as const

/** A tool input for the type with every field empty and no lines, then the given values. */
function emptyInput(docType: DocType, overrides: Record<string, unknown> = {}) {
  const def = DOC_TYPES[docType]
  return { ...Object.fromEntries(def.fields.map((d) => [d.name, f('')])), [def.linesKey]: [], ...overrides }
}

describe('the type registry', () => {
  it('has the six types, and maps tool names to types', () => {
    expect(Object.keys(DOC_TYPES)).toEqual(TYPES)
    for (const t of TYPES) expect(docTypeOfTool(`record_${t}`)).toBe(t)
    expect(docTypeOfTool('record_not_supported')).toBe('not_supported')
    expect(docTypeOfTool('record_payslip')).toBeNull()
  })

  it('sends every type’s tool and record_not_supported to detect, and only the chosen type’s tool otherwise', () => {
    expect(toolsFor(null).map((t) => t.name)).toEqual([...TYPES.map((t) => `record_${t}`), 'record_not_supported'])
    for (const t of TYPES) expect(toolsFor(t).map((tool) => tool.name)).toEqual([`record_${t}`])
    for (const tool of toolsFor(null)) expect(tool.strict).toBe(true)
  })

  it('does not name a supported type as an example of an unsupported one', () => {
    expect(RECORD_NOT_SUPPORTED.description).not.toMatch(/receipt|statement|order|delivery|quote|invoice/i)
  })

  it.each(TYPES)('%s has the common fields and a strict tool within strict mode’s limits', (t) => {
    const def = DOC_TYPES[t]
    expect(def.fields.slice(0, 3).map((d) => d.name)).toEqual(['language', 'currency', 'currency_as_printed'])
    const schema = def.tool.input_schema as { properties: Record<string, { type: string }>; required: string[] }
    expect(schema.required.sort()).toEqual([...def.fields.map((d) => d.name), def.linesKey].sort())
    expect(schema.properties[def.linesKey].type).toBe('array')
    const json = JSON.stringify(def.tool.input_schema)
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
    walk(def.tool.input_schema)
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false)
      expect([...(o.required ?? [])].sort()).toEqual(Object.keys(o.properties ?? {}).sort())
    }
  })
})

describe('prepareResult for every type', () => {
  it.each(TYPES)('%s: stores every field, runs its checks with U1 last, and keys it for U1', (t) => {
    const result = prepareResult(t, emptyInput(t), CONFIG)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.fields.map((r) => r.path)).toEqual(DOC_TYPES[t].fields.map((d) => d.name))
    expect(result.checks.at(-1)?.check_id).toBe('U1')
    // Nothing is printed: every check is skipped (OQ-43), and there is no key.
    expect(result.checks.filter((c) => c.status !== 'skipped')).toEqual([])
    expect(result.duplicate.key).toBeNull()
  })

  it('stores a bank statement’s transactions as line_items[i]', () => {
    const transaction = { date: f('2026-09-03'), description: f('Salary'), reference: f(''), amount: f('100.00'), balance: f('') }
    const result = prepareResult('bank_statement', emptyInput('bank_statement', { transactions: [transaction] }), CONFIG)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.fields.filter((r) => r.path.startsWith('line_items[0].')).map((r) => r.path)).toEqual([
      'line_items[0].date',
      'line_items[0].description',
      'line_items[0].reference',
      'line_items[0].amount',
      'line_items[0].balance',
    ])
    // line_items is not the bank statement's key.
    expect(prepareResult('bank_statement', { ...emptyInput('bank_statement'), line_items: [] }, CONFIG).ok).toBe(false)
  })

  it('cuts card, account and IBAN numbers to their last four characters, without spaces (OQ-29)', () => {
    const receipt = prepareResult('receipt', emptyInput('receipt', { card_last4: f('4000 1234 5678 9010') }), CONFIG)
    const bank = prepareResult(
      'bank_statement',
      emptyInput('bank_statement', { account_number_last4: f('12345678'), iban_last4: f('XX00 0000 0000 0000 43 21') }),
      CONFIG,
    )
    if (!receipt.ok || !bank.ok) throw new Error('invalid')
    const value = (rows: { path: string; extracted_value: string | null }[], path: string) => rows.find((r) => r.path === path)?.extracted_value
    expect(value(receipt.fields, 'card_last4')).toBe('9010')
    expect(value(bank.fields, 'account_number_last4')).toBe('5678')
    expect(value(bank.fields, 'iban_last4')).toBe('4321')
    // The key reads the cut value too.
    const keyed = prepareResult(
      'bank_statement',
      emptyInput('bank_statement', {
        bank_name: f('Example Bank'),
        account_number_last4: f('DE00 1234 5678'),
        statement_period_start: f('2026-09-01'),
        statement_period_end: f('2026-09-30'),
      }),
      CONFIG,
    )
    if (!keyed.ok) throw new Error('invalid')
    expect(keyed.duplicate.key).toBe('bank_statement|examplebank|5678|20260901|20260930')
  })

  it('flags the currency as guessed when none is printed, or only an ambiguous symbol (OQ-16)', () => {
    const flags = (t: DocType, printed: string) => {
      const result = prepareResult(t, emptyInput(t, { currency: f('USD'), currency_as_printed: f(printed) }), CONFIG)
      if (!result.ok) throw new Error('invalid')
      return result.fields.find((r) => r.path === 'currency')?.flags
    }
    expect(flags('invoice', '')).toEqual(['currency_guessed'])
    expect(flags('receipt', '$')).toEqual(['currency_guessed'])
    expect(flags('quote', 'kr')).toEqual(['currency_guessed'])
    expect(flags('invoice', 'US$')).toEqual([])
    expect(flags('purchase_order', 'USD')).toEqual([])
    expect(flags('bank_statement', '€')).toEqual([])
    // A delivery note is never flagged for its currency, and its currency may be empty.
    expect(flags('delivery_note', '')).toEqual([])
    const empty = prepareResult('delivery_note', emptyInput('delivery_note'), CONFIG)
    if (!empty.ok) throw new Error('invalid')
    expect(empty.fields.find((r) => r.path === 'currency')).toMatchObject({ extracted_value: null, flags: [] })
  })

  it('reads today for the date checks (OQ-6)', () => {
    const input = emptyInput('receipt', { transaction_date: f('2026-11-05') })
    const check = (today: string) => {
      const result = prepareResult('receipt', input, { ...CONFIG, today })
      if (!result.ok) throw new Error('invalid')
      return result.checks.find((c) => c.check_id === 'D1')?.status
    }
    expect(check('2026-10-31')).toBe('fail')
    expect(check('2026-11-04')).toBe('pass')
  })
})

describe('record_not_supported', () => {
  it('takes a short reason', () => {
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
