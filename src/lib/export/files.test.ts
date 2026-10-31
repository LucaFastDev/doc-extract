import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { INVOICE_FIELDS, INVOICE_LINE_ITEM_FIELDS } from '@shared/doctypes/invoice'
import { buildCsvZip, buildXlsx } from './files'
import type { ExportDocument, ExportInput } from './model'

// The two files an export downloads (PRD US-6.1 AC-4 and AC-5; Lead rulings 1 to 3 on #39), read
// back: the XLSX by unzipping it and reading its sheet XML, the zip by unzipping it.

const empty = (defs: { name: string }[]) => Object.fromEntries(defs.map((d) => [d.name, null]))

function doc(over: Partial<ExportDocument> = {}): ExportDocument {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    fileName: 'Rechnung März.pdf',
    approvedAt: '2026-10-31T14:05:12.345678+00:00',
    fields: {
      ...empty(INVOICE_FIELDS),
      vendor_name: '=HYPERLINK("http://x","click")',
      invoice_number: 'INV-1042',
      currency: 'EUR',
      invoice_date: '2026-10-01',
      due_date: 'next week',
      subtotal: '100.00',
      discount_total: '-12.50',
      total: '=1+1',
    },
    lineItems: [{ ...empty(INVOICE_LINE_ITEM_FIELDS), description: 'Widgets, large', quantity: '4', tax_rate: '19', amount: '100.00' }],
    ...over,
  }
}

const INPUT: ExportInput = { docType: 'invoice', documents: [doc()] }

// Reading an XLSX ---------------------------------------------------------------------------------

interface XlsxCell {
  /** The t attribute: s for a shared string, absent for a number or a date. */
  t: string | null
  /** The cell's value: the shared string's text, or the number as written. */
  value: string
  formula: boolean
  /** The number format code of the cell's style, if any. */
  format: string | null
}

const unescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null

function readXlsx(bytes: Uint8Array) {
  const files = unzipSync(bytes)
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '')
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  )
  const styles = text('xl/styles.xml')
  const formats = new Map([...styles.matchAll(/<numFmt\b([^>]*)\/>/g)].map((m) => [attr(m[1], 'numFmtId'), unescape(attr(m[1], 'formatCode') ?? '')]))
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? ''
  const styleFormats = [...xfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => formats.get(attr(m[1], 'numFmtId')) ?? null)

  const workbook = text('xl/workbook.xml')
  const rels = text('xl/_rels/workbook.xml.rels')
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/>/g)].map((m) => {
    const name = unescape(attr(m[1], 'name') ?? '')
    const target = attr(new RegExp(`<Relationship\\b[^>]*Id="${attr(m[1], 'r:id')}"[^>]*/>`).exec(rels)?.[0] ?? '', 'Target') ?? ''
    const xml = text(`xl/${target.replace(/^\/?xl\//, '')}`)
    const cells = new Map<string, XlsxCell>()
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[2] ?? ''
      const t = attr(c[1], 't')
      const v = unescape(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      const s = attr(c[1], 's')
      cells.set(attr(c[1], 'r')!, {
        t,
        value: t === 's' ? shared[Number(v)] : v,
        formula: /<f\b/.test(body),
        format: s === null ? null : styleFormats[Number(s)],
      })
    }
    return { name, cells }
  })
  return sheets
}

/** The cell under a header in a sheet's first data row (row 2). */
function cellUnder(sheet: ReturnType<typeof readXlsx>[number], header: string, row = 2): XlsxCell | undefined {
  for (const [ref, cell] of sheet.cells) {
    const m = /^([A-Z]+)1$/.exec(ref)
    if (m && cell.value === header) return sheet.cells.get(`${m[1]}${row}`)
  }
  throw new Error(`no column ${header}`)
}

/** An Excel serial date as yyyy-mm-dd hh:mm, in UTC. */
const fromSerial = (serial: string) => new Date(Math.round((Number(serial) - 25569) * 86400000)).toISOString().slice(0, 16).replace('T', ' ')

describe('buildXlsx', () => {
  it('has the sheets "Documents" and "Line items"', async () => {
    const sheets = readXlsx(await buildXlsx(INPUT))
    expect(sheets.map((s) => s.name)).toEqual(['Documents', 'Line items'])
  })

  it('writes the header row with the field names', async () => {
    const [documents, lines] = readXlsx(await buildXlsx(INPUT))
    expect(documents.cells.get('A1')?.value).toBe('document_id')
    expect(documents.cells.get('C1')?.value).toBe('approved_at')
    expect(lines.cells.get('C1')?.value).toBe('position')
  })

  it('writes an amount as a numeric cell, a negative one too', async () => {
    const [documents] = readXlsx(await buildXlsx(INPUT))
    expect(cellUnder(documents, 'subtotal')).toMatchObject({ t: null, value: '100', formula: false })
    expect(cellUnder(documents, 'discount_total')).toMatchObject({ t: null, value: '-12.5', formula: false })
  })

  it('writes a percent and a number as numeric cells, the percent as stored', async () => {
    const [, lines] = readXlsx(await buildXlsx(INPUT))
    expect(cellUnder(lines, 'tax_rate')).toMatchObject({ t: null, value: '19' })
    expect(cellUnder(lines, 'quantity')).toMatchObject({ t: null, value: '4' })
    expect(cellUnder(lines, 'position')).toMatchObject({ t: null, value: '1' })
  })

  it('writes a date as a real date shown as yyyy-mm-dd', async () => {
    const [documents] = readXlsx(await buildXlsx(INPUT))
    const date = cellUnder(documents, 'invoice_date')!
    expect(date.t).toBeNull()
    expect(date.format).toBe('yyyy-mm-dd')
    expect(fromSerial(date.value)).toBe('2026-10-01 00:00')
  })

  it('writes approved_at as a UTC date and time shown as yyyy-mm-dd hh:mm', async () => {
    const [documents] = readXlsx(await buildXlsx(INPUT))
    const approved = cellUnder(documents, 'approved_at')!
    expect(approved.t).toBeNull()
    expect(approved.format).toBe('yyyy-mm-dd hh:mm')
    expect(fromSerial(approved.value)).toBe('2026-10-31 14:05')
  })

  it('leaves an empty or missing value as an empty cell', async () => {
    const [documents, lines] = readXlsx(await buildXlsx(INPUT))
    expect(cellUnder(documents, 'shipping')).toBeUndefined()
    expect(cellUnder(lines, 'unit')).toBeUndefined()
  })

  it('writes a value that does not parse as its kind as text', async () => {
    const [documents] = readXlsx(await buildXlsx(INPUT))
    expect(cellUnder(documents, 'due_date')).toMatchObject({ t: 's', value: 'next week' })
    expect(cellUnder(documents, 'total')).toMatchObject({ t: 's', value: '=1+1', formula: false })
  })

  it('writes every text value as a string cell, never a formula (Lead ruling 3)', async () => {
    const [documents, lines] = readXlsx(await buildXlsx(INPUT))
    expect(cellUnder(documents, 'vendor_name')).toEqual({ t: 's', value: '=HYPERLINK("http://x","click")', formula: false, format: null })
    expect(cellUnder(documents, 'file_name')).toMatchObject({ t: 's', value: 'Rechnung März.pdf' })
    expect(cellUnder(lines, 'description')).toMatchObject({ t: 's', value: 'Widgets, large' })
    for (const sheet of [documents, lines]) for (const cell of sheet.cells.values()) expect(cell.formula).toBe(false)
  })
})

describe('buildCsvZip', () => {
  const header = (fields: { name: string }[], lead: string[]) => [...lead, ...fields.map((d) => d.name)].join(',')

  it('holds exactly documents.csv and line_items.csv, with the expected bytes', () => {
    const files = unzipSync(buildCsvZip(INPUT))
    expect(Object.keys(files).sort()).toEqual(['documents.csv', 'line_items.csv'])

    const values: Record<string, string> = {
      document_id: '11111111-1111-4111-8111-111111111111',
      file_name: 'Rechnung März.pdf',
      approved_at: '2026-10-31T14:05:12Z',
      // Ruling 3: text gets a quote in front; the parsed negative amount does not.
      vendor_name: `"'=HYPERLINK(""http://x"",""click"")"`,
      invoice_number: 'INV-1042',
      currency: 'EUR',
      invoice_date: '2026-10-01',
      due_date: 'next week',
      subtotal: '100.00',
      discount_total: '-12.50',
      total: "'=1+1",
    }
    const documentsCsv =
      header(INVOICE_FIELDS, ['document_id', 'file_name', 'approved_at']) +
      '\r\n' +
      ['document_id', 'file_name', 'approved_at', ...INVOICE_FIELDS.map((d) => d.name)].map((n) => values[n] ?? '').join(',') +
      '\r\n'
    const lineValues: Record<string, string> = {
      document_id: '11111111-1111-4111-8111-111111111111',
      file_name: 'Rechnung März.pdf',
      position: '1',
      description: '"Widgets, large"',
      quantity: '4',
      tax_rate: '19',
      amount: '100.00',
    }
    const linesCsv =
      header(INVOICE_LINE_ITEM_FIELDS, ['document_id', 'file_name', 'position']) +
      '\r\n' +
      ['document_id', 'file_name', 'position', ...INVOICE_LINE_ITEM_FIELDS.map((d) => d.name)].map((n) => lineValues[n] ?? '').join(',') +
      '\r\n'

    // UTF-8, byte for byte.
    expect(Buffer.from(files['documents.csv'])).toEqual(Buffer.from(documentsCsv, 'utf8'))
    expect(Buffer.from(files['line_items.csv'])).toEqual(Buffer.from(linesCsv, 'utf8'))
  })

  it('guards an amount that does not parse, like =1+1, and leaves parsed numbers and dates unchanged (Lead ruling on #39)', () => {
    const input: ExportInput = {
      docType: 'invoice',
      documents: [doc({ fields: { ...doc().fields, vendor_name: 'Acme', total: '=1+1', subtotal: '-5', invoice_date: '-2026-10-01', due_date: '2026-11-01' } })],
    }
    const csv = strFromU8(unzipSync(buildCsvZip(input))['documents.csv'])
    const [head, row] = csv.split('\r\n')
    const cols = head.split(',')
    const cells = row.split(',')
    expect(cells[cols.indexOf('total')]).toBe("'=1+1")
    expect(cells[cols.indexOf('subtotal')]).toBe('-5')
    expect(cells[cols.indexOf('invoice_date')]).toBe("'-2026-10-01")
    expect(cells[cols.indexOf('due_date')]).toBe('2026-11-01')
  })

  it('has the same columns and rows as the two sheets', async () => {
    const two: ExportInput = { docType: 'invoice', documents: [doc(), doc({ id: 'second', fileName: 'b.pdf', lineItems: [] })] }
    const files = unzipSync(buildCsvZip(two))
    const [documents, lines] = readXlsx(await buildXlsx(two))
    const rowsOf = (csv: string) => csv.split('\r\n').filter(Boolean)
    const sheetRows = (sheet: typeof documents) => new Set([...sheet.cells.keys()].map((r) => /\d+$/.exec(r)![0])).size
    expect(rowsOf(strFromU8(files['documents.csv']))).toHaveLength(sheetRows(documents))
    expect(rowsOf(strFromU8(files['line_items.csv']))).toHaveLength(sheetRows(lines))
    expect(rowsOf(strFromU8(files['documents.csv']))[0].split(',')).toEqual(
      [...documents.cells].filter(([r]) => /^[A-Z]+1$/.test(r)).map(([, c]) => c.value),
    )
  })
})
