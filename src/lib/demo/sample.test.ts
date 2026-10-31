import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { applyCorrection, deleteLine } from '@/lib/documents/review'
import { buildCsvZip } from '@/lib/export/files'
import { exportTables } from '@/lib/export/model'
import { demoExportInput, demoMimeType, demoReviewData, type DemoSample } from './sample'

// The demo's model (issue #41 criteria 6 and 7, Lead ruling 4): a sample as the review screen and
// the export take it.

const SAMPLE: DemoSample = {
  id: '4a3c4b8e-5f1e-4d0a-9a51-0c2f6b8f1d10',
  slug: 'receipt-photo',
  doc_type: 'receipt',
  title: 'Photographed café receipt',
  summary: 'Low-confidence fields',
  page_count: 1,
  file_path: 'receipt-photo.png',
  result: {
    doc_type: 'receipt',
    amount_tolerance: '0.01',
    fields: [
      { path: 'merchant_name', kind: 'text', extracted_value: 'THE GILDED SPOON CAFE', confidence: 0.93, flags: [] },
      { path: 'merchant_tax_id', kind: 'text', extracted_value: 'EX 555 0101 22', confidence: 0.58, flags: ['low_confidence'] },
      { path: 'total', kind: 'amount', extracted_value: '18.99', confidence: 0.92, flags: [] },
      { path: 'line_items[0].description', kind: 'text', extracted_value: 'FLAT WHITE', confidence: 0.93, flags: [] },
      { path: 'line_items[0].amount', kind: 'amount', extracted_value: '6.80', confidence: 0.92, flags: [] },
      { path: 'line_items[1].description', kind: 'text', extracted_value: 'OAT PORRIDGE', confidence: 0.93, flags: [] },
      { path: 'line_items[1].amount', kind: 'amount', extracted_value: '5.90', confidence: 0.92, flags: [] },
    ],
    checks: [{ check_id: 'A3', status: 'skipped', field_paths: ['subtotal'], message: 'Skipped: no subtotal is printed.' }],
  },
}

describe('demoMimeType', () => {
  it('reads the type from the file’s extension', () => {
    expect(demoMimeType('bank-statement.pdf')).toBe('application/pdf')
    expect(demoMimeType('receipt-photo.png')).toBe('image/png')
    expect(demoMimeType('scan.JPG')).toBe('image/jpeg')
    expect(demoMimeType('scan.webp')).toBe('image/webp')
    expect(demoMimeType('notes.txt')).toBe('application/octet-stream')
  })
})

describe('demoReviewData', () => {
  it('is the stored result needing review, nothing corrected or ticked, with no history', () => {
    const data = demoReviewData(SAMPLE)
    expect(data.document).toMatchObject({
      id: SAMPLE.id,
      file_name: 'receipt-photo.png',
      storage_path: 'receipt-photo.png',
      mime_type: 'image/png',
      status: 'needs_review',
      doc_type: 'receipt',
      page_count: 1,
      file_deleted_at: null,
      approved_at: null,
    })
    expect(data.fields).toEqual(SAMPLE.result.fields.map((f) => ({ ...f, corrected_value: null })))
    expect(data.checks).toBe(SAMPLE.result.checks)
    expect(data).toMatchObject({ ticks: [], events: [], people: {} })
  })
})

describe('demoExportInput', () => {
  it('exports the sample as edited, under its id and file name, with approved_at empty (Lead ruling 4)', () => {
    const rows = deleteLine(applyCorrection(demoReviewData(SAMPLE).fields, 'total', '19.99'), 0)
    const input = demoExportInput(SAMPLE, rows)
    expect(input.docType).toBe('receipt')
    expect(input.documents).toHaveLength(1)
    expect(input.documents[0]).toMatchObject({ id: SAMPLE.id, fileName: 'receipt-photo.png', approvedAt: null })
    expect(input.documents[0].fields).toMatchObject({ total: '19.99', merchant_tax_id: 'EX 555 0101 22', subtotal: null })
    expect(input.documents[0].lineItems).toEqual([{ description: 'OAT PORRIDGE', quantity: null, unit_price: null, amount: '5.90' }])

    const { documents } = exportTables(input)
    expect(documents.rows[0].slice(0, 3)).toEqual([
      { type: 'text', text: SAMPLE.id },
      { type: 'text', text: 'receipt-photo.png' },
      null,
    ])

    const csv = strFromU8(unzipSync(buildCsvZip(input))['documents.csv']).split('\r\n')
    expect(csv[1].startsWith(`${SAMPLE.id},receipt-photo.png,,`)).toBe(true)
  })
})
