import { describe, expect, it } from 'vitest'
import { BANK_STATEMENT_FIELDS } from '@shared/doctypes/bank-statement'
import { DOC_TYPES, prepareResult } from '@shared/doctypes/index'
import { INVOICE_FIELDS, INVOICE_LINE_ITEM_FIELDS } from '@shared/doctypes/invoice'
import { addLine, applyCorrection, deleteLine, type ReviewRow } from '@/lib/documents/review'
import { cellFor, exportDocument, exportFileName, exportTables, type ExportDocument } from './model'

// What an export holds (PRD US-6.1 AC-2 to AC-5; Lead rulings 1 and 2 on #39): the columns, one
// cell per value with its kind, and each document's values from its extraction_fields rows, the
// correction winning, deleted lines left out and added lines included.

const f = (value: string, confidence = 0.95) => ({ value, confidence })

/** An approved invoice's rows as record_extraction stores them: two lines. */
function invoiceRows(): ReviewRow[] {
  const input = {
    ...Object.fromEntries(INVOICE_FIELDS.map((d) => [d.name, f('')])),
    vendor_name: f('Acme Supplies Ltd'),
    invoice_number: f('INV-1042'),
    currency: f('EUR'),
    invoice_date: f('2026-10-01'),
    subtotal: f('120.00'),
    total: f('142.80'),
    line_items: [
      { description: f('Widgets'), item_code: f('W-1'), quantity: f('4'), unit: f('pcs'), unit_price: f('25.00'), tax_rate: f('19'), amount: f('100.00') },
      { description: f('Bolts'), item_code: f('B-2'), quantity: f('10'), unit: f('pcs'), unit_price: f('2.00'), tax_rate: f('19'), amount: f('20.00') },
    ],
  }
  const prepared = prepareResult('invoice', input, { confidenceThreshold: 0.8, amountTolerance: '0.01', today: '2026-10-31' })
  if (!prepared.ok) throw new Error(prepared.errors.join('; '))
  return prepared.fields.map((r) => ({ ...r, corrected_value: null }))
}

const DOC = { id: 'doc-1', file_name: 'a.pdf', approved_at: '2026-10-31T14:05:12.345678+00:00' }

describe('exportDocument', () => {
  it('takes every header field in the type, null when there is no value', () => {
    const doc = exportDocument('invoice', DOC, invoiceRows())
    expect(doc.id).toBe('doc-1')
    expect(doc.fileName).toBe('a.pdf')
    expect(doc.approvedAt).toBe(DOC.approved_at)
    expect(Object.keys(doc.fields)).toEqual(INVOICE_FIELDS.map((d) => d.name))
    expect(doc.fields.vendor_name).toBe('Acme Supplies Ltd')
    expect(doc.fields.due_date).toBeNull()
  })

  it('uses the corrected value where there is one and the extracted value otherwise (US-6.1 AC-2)', () => {
    let rows = applyCorrection(invoiceRows(), 'subtotal', '100.00')
    rows = applyCorrection(rows, 'line_items[1].description', 'Steel bolts')
    rows = applyCorrection(rows, 'vendor_tax_id', '')
    const doc = exportDocument('invoice', DOC, rows)
    expect(doc.fields.subtotal).toBe('100.00')
    expect(doc.fields.total).toBe('142.80')
    expect(doc.lineItems[1].description).toBe('Steel bolts')
    expect(doc.lineItems[0].description).toBe('Widgets')
    // A field the user emptied is empty, not its extracted value.
    expect(doc.fields.vendor_tax_id).toBe('')
  })

  it('leaves a deleted line item out', () => {
    const rows = deleteLine(invoiceRows(), 0)
    const doc = exportDocument('invoice', DOC, rows)
    expect(doc.lineItems).toHaveLength(1)
    expect(doc.lineItems[0].description).toBe('Bolts')
  })

  it('includes an added line item, in its place', () => {
    let rows = addLine(invoiceRows(), INVOICE_LINE_ITEM_FIELDS, 0)
    rows = applyCorrection(rows, 'line_items[1].description', 'Delivery')
    rows = applyCorrection(rows, 'line_items[1].amount', '5.00')
    const doc = exportDocument('invoice', DOC, rows)
    expect(doc.lineItems.map((l) => l.description)).toEqual(['Widgets', 'Delivery', 'Bolts'])
    expect(doc.lineItems[1].amount).toBe('5.00')
    expect(doc.lineItems[1].quantity).toBeNull()
    expect(Object.keys(doc.lineItems[1])).toEqual(INVOICE_LINE_ITEM_FIELDS.map((d) => d.name))
  })
})

describe('cellFor (Lead ruling 2)', () => {
  it('makes an empty or missing value an empty cell', () => {
    for (const kind of ['text', 'date', 'amount', 'number', 'percent'] as const) {
      expect(cellFor(kind, null)).toBeNull()
      expect(cellFor(kind, '')).toBeNull()
    }
  })

  it('makes an amount, number or percent that parses a number, with its decimal text as stored', () => {
    expect(cellFor('amount', '1180.10')).toEqual({ type: 'number', text: '1180.10' })
    expect(cellFor('amount', '-12.50')).toEqual({ type: 'number', text: '-12.50' })
    expect(cellFor('number', '2.5')).toEqual({ type: 'number', text: '2.5' })
    // A percent of 19 stays 19, not 0.19.
    expect(cellFor('percent', '19')).toEqual({ type: 'number', text: '19' })
  })

  it('makes an amount, number or percent that does not parse text, as written', () => {
    expect(cellFor('amount', '1,180.00')).toEqual({ type: 'text', text: '1,180.00' })
    expect(cellFor('amount', '=1+1')).toEqual({ type: 'text', text: '=1+1' })
    expect(cellFor('percent', '19%')).toEqual({ type: 'text', text: '19%' })
  })

  it('makes a full date a date, and anything else text', () => {
    expect(cellFor('date', '2026-10-01')).toEqual({ type: 'date', text: '2026-10-01' })
    expect(cellFor('date', '2026-10')).toEqual({ type: 'text', text: '2026-10' })
    expect(cellFor('date', '2026-02-30')).toEqual({ type: 'text', text: '2026-02-30' })
    expect(cellFor('date', '01.10.2026')).toEqual({ type: 'text', text: '01.10.2026' })
  })

  it('keeps text as it is', () => {
    expect(cellFor('text', ' Acme ')).toEqual({ type: 'text', text: ' Acme ' })
  })
})

describe('exportTables (Lead ruling 1)', () => {
  const invoice = (): ExportDocument => exportDocument('invoice', DOC, invoiceRows())

  it('names the columns by field name, in the type’s order, every field included', () => {
    const { documents, lineItems } = exportTables({ docType: 'invoice', documents: [invoice()] })
    expect(documents.header).toEqual(['document_id', 'file_name', 'approved_at', ...INVOICE_FIELDS.map((d) => d.name)])
    expect(lineItems.header).toEqual(['document_id', 'file_name', 'position', ...INVOICE_LINE_ITEM_FIELDS.map((d) => d.name)])
  })

  it('has one Documents row per document and one Line items row per line, numbered from 1', () => {
    const doc = invoice()
    const second = { ...doc, id: 'doc-2', fileName: 'b.pdf', lineItems: [] }
    const { documents, lineItems } = exportTables({ docType: 'invoice', documents: [doc, second] })
    expect(documents.rows).toHaveLength(2)
    expect(documents.rows[0].slice(0, 3)).toEqual([
      { type: 'text', text: 'doc-1' },
      { type: 'text', text: 'a.pdf' },
      { type: 'datetime', iso: DOC.approved_at },
    ])
    expect(documents.rows[1][0]).toEqual({ type: 'text', text: 'doc-2' })
    expect(lineItems.rows.map((r) => r.slice(0, 3))).toEqual([
      [{ type: 'text', text: 'doc-1' }, { type: 'text', text: 'a.pdf' }, { type: 'number', text: '1' }],
      [{ type: 'text', text: 'doc-1' }, { type: 'text', text: 'a.pdf' }, { type: 'number', text: '2' }],
    ])
    const subtotal = documents.header.indexOf('subtotal')
    expect(documents.rows[0][subtotal]).toEqual({ type: 'number', text: '120.00' })
    expect(documents.rows[0][documents.header.indexOf('due_date')]).toBeNull()
  })

  it('takes a bank statement’s transactions as its line items', () => {
    const { documents, lineItems } = exportTables({ docType: 'bank_statement', documents: [] })
    expect(documents.header.slice(3)).toEqual(BANK_STATEMENT_FIELDS.map((d) => d.name))
    expect(lineItems.header.slice(3)).toEqual(DOC_TYPES.bank_statement.lineFields.map((d) => d.name))
  })
})

describe('exportFileName', () => {
  it('names the file by the type in kebab case and the date the export was made', () => {
    const now = new Date('2026-10-31T23:30:00Z')
    expect(exportFileName('invoice', 'xlsx', now)).toBe('invoice-export-2026-10-31.xlsx')
    expect(exportFileName('bank_statement', 'csv', now)).toBe('bank-statement-export-2026-10-31.zip')
    expect(exportFileName('purchase_order', 'xlsx', now)).toBe('purchase-order-export-2026-10-31.xlsx')
  })
})
