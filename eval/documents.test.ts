import { readdirSync, readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { utcDate } from '@shared/doctypes/checks'
import { LAST4_FIELDS } from '@shared/doctypes/fields'
import { DOC_TYPES, prepareResult, type DocType } from '@shared/doctypes/index'
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_PAGES } from '@shared/limits'
import { buildDocuments, expectedFile, expectedJson, expectedResult, printedValue, receiptLines } from './make-documents'
import { toolInput } from './run'
import type { ExpectedResult } from './score'
import { DOCUMENTS_DIR, EVAL_DOCUMENTS, EXPECTED_DIR, type EvalDocument } from './values'

// The eval set (issue #43 criteria 1 and 2): the committed documents and expected results are what
// the generator makes from values.ts; each document prints every value its expected result holds;
// each expected result is what the app's own validation stores for those values; every printed
// total adds up; and each type's five documents vary as criterion 1 asks.

const TYPES = Object.keys(DOC_TYPES) as DocType[]
const today = utcDate(new Date())
const bytesOf = (doc: EvalDocument) => new Uint8Array(readFileSync(new URL(doc.file, DOCUMENTS_DIR)))
const committedExpected = (doc: EvalDocument) => JSON.parse(readFileSync(new URL(expectedFile(doc), EXPECTED_DIR), 'utf8')) as ExpectedResult
const pageCount = async (doc: EvalDocument) => (doc.file.endsWith('.pdf') ? (await PDFDocument.load(bytesOf(doc))).getPageCount() : 1)

/**
 * Every text item of every page of a PDF, one per line. Without the standard fonts' data, pdfjs
 * gives the Courier and Times documents one item per word with a lone space item between them;
 * those words were drawn as one string, so they are joined again.
 */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise
  const pages: string[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    pages.push(content.items.map((i) => ('str' in i ? i.str : '')).join('\n').replace(/\n \n/g, ' '))
  }
  await pdf.destroy()
  return pages.join('\n')
}

describe('the eval documents', () => {
  it('are what the generator makes, byte for byte, and nothing else', async () => {
    const built = await buildDocuments()
    expect(readdirSync(DOCUMENTS_DIR).sort()).toEqual([...built.keys()].sort())
    for (const [name, bytes] of built) expect(new Uint8Array(readFileSync(new URL(name, DOCUMENTS_DIR))), name).toEqual(bytes)
  }, 60_000)

  it('are 30, five per type, each of a different layout, named after their type', () => {
    expect(EVAL_DOCUMENTS).toHaveLength(30)
    for (const type of TYPES) {
      const docs = EVAL_DOCUMENTS.filter((d) => d.docType === type)
      expect(docs, type).toHaveLength(5)
      expect(new Set(docs.map((d) => d.style.layout)).size, type).toBe(5)
      for (const d of docs) expect(d.file, type).toMatch(new RegExp(`^${type.replace('_', '-')}-0[1-5]\\.(pdf|png)$`))
    }
  })

  it('have, per type, one not in English, two currencies and one field the document does not show', () => {
    for (const type of TYPES) {
      const docs = EVAL_DOCUMENTS.filter((d) => d.docType === type)
      expect(docs.some((d) => d.style.lang !== 'en'), type).toBe(true)
      expect(new Set(docs.map((d) => d.fields.currency).filter(Boolean)).size, type).toBeGreaterThanOrEqual(2)
      expect(docs.some((d) => expectedResult(d).fields.some((f) => f.value === null)), type).toBe(true)
    }
  })

  it('have three receipts as photos, an invoice and a bank statement of two pages or more, all within the upload limits', async () => {
    expect(EVAL_DOCUMENTS.filter((d) => d.docType === 'receipt' && /\.(png|jpe?g)$/.test(d.file)).length).toBeGreaterThanOrEqual(3)
    for (const type of ['invoice', 'bank_statement'] as const) {
      const pages = await Promise.all(EVAL_DOCUMENTS.filter((d) => d.docType === type).map(pageCount))
      expect(Math.max(...pages), type).toBeGreaterThanOrEqual(2)
    }
    for (const d of EVAL_DOCUMENTS) {
      expect(await pageCount(d), d.file).toBeLessThanOrEqual(MAX_PAGES)
      expect(bytesOf(d).length, d.file).toBeLessThanOrEqual(d.file.endsWith('.pdf') ? MAX_FILE_BYTES : MAX_IMAGE_BYTES)
    }
  })

  it('print every value their expected results hold', async () => {
    for (const d of EVAL_DOCUMENTS) {
      const text = d.file.endsWith('.pdf')
        ? await pdfText(bytesOf(d))
        : receiptLines(d)
            .map((l) => l.text.trim())
            .join(' ')
      for (const f of expectedResult(d).fields) {
        const name = f.path.replace(/^line_items\[\d+\]\./, '')
        // The language and the currency code are read from the document, not printed on it.
        if (f.value === null || name === 'language' || name === 'currency') continue
        // A card, account or IBAN number keeps its last four characters without spaces (OQ-29),
        // which may straddle a space where it is printed in groups.
        const last4 = (LAST4_FIELDS as readonly string[]).includes(name)
        expect(last4 ? text.replace(/\s/g, '') : text, `${d.file}: ${f.path}`).toContain(printedValue(d, name, f.value))
      }
    }
  })
})

describe('the expected results', () => {
  it('are committed as the generator writes them, one per document and nothing else', () => {
    expect(readdirSync(EXPECTED_DIR).sort()).toEqual(EVAL_DOCUMENTS.map(expectedFile).sort())
    for (const d of EVAL_DOCUMENTS) expect(readFileSync(new URL(expectedFile(d), EXPECTED_DIR), 'utf8'), d.file).toBe(expectedJson(d))
  })

  it('hold every field and cell of the type, as the app’s validation stores them', () => {
    for (const d of EVAL_DOCUMENTS) {
      const e = committedExpected(d)
      expect(e.document).toBe(d.file)
      expect(e.doc_type).toBe(d.docType)
      const prepared = prepareResult(d.docType, toolInput(e), { confidenceThreshold: 0.8, amountTolerance: '0.01', today })
      if (!prepared.ok) throw new Error(`${d.file}: ${prepared.errors.join('; ')}`)
      expect(
        prepared.fields.map((f) => ({ path: f.path, kind: f.kind, value: f.extracted_value })),
        d.file,
      ).toEqual(e.fields)
    }
  })

  it('keep dates as YYYY-MM-DD, amounts and numbers as plain decimals, and card and account numbers as four characters', () => {
    for (const d of EVAL_DOCUMENTS) {
      for (const f of committedExpected(d).fields) {
        if (f.value === null) continue
        if (f.kind === 'date') expect(f.value, `${d.file} ${f.path}`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        if (f.kind === 'amount' || f.kind === 'number' || f.kind === 'percent') expect(f.value, `${d.file} ${f.path}`).toMatch(/^-?\d+(\.\d+)?$/)
        if (/(card_last4|account_number_last4|iban_last4)$/.test(f.path)) expect(f.value, `${d.file} ${f.path}`).toMatch(/^\S{4}$/)
      }
    }
  })

  it('add up: no check of the type fails on them, and every arithmetic check that can run passes', () => {
    for (const d of EVAL_DOCUMENTS) {
      const prepared = prepareResult(d.docType, toolInput(committedExpected(d)), { confidenceThreshold: 0.8, amountTolerance: '0.01', today })
      if (!prepared.ok) throw new Error(d.file)
      expect(
        prepared.checks.filter((c) => c.status === 'fail').map((c) => `${c.check_id}: ${c.message}`),
        d.file,
      ).toEqual([])
      expect(prepared.checks.some((c) => c.check_id.startsWith('A') && c.status === 'pass'), d.file).toBe(true)
    }
  })
})
