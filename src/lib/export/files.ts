import { strToU8, zipSync } from 'fflate'
import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/universal'
import { guardFormula, toCsv } from './csv'
import { exportTables, type ExportCell, type ExportInput, type ExportTable } from './model'

// The export's file bytes (PRD US-6.1 AC-4 and AC-5, OQ-13; Lead rulings 1 to 3 on #39), built
// from plain data and nothing else: no Supabase, no React, no browser API but Blob, so the export
// page and the demo (milestone 11) call the same code. The page loads this module only when the
// user presses Download, so fflate and write-excel-file stay out of every other page's bundle.

const DATE_FORMAT = 'yyyy-mm-dd'
const DATE_TIME_FORMAT = 'yyyy-mm-dd hh:mm'

/** A YYYY-MM-DD date as midnight UTC, which write-excel-file turns into its serial day. */
const utcMidnight = (date: string) => new Date(`${date}T00:00:00Z`)

/**
 * An XLSX cell: a number cell, a date cell shown as yyyy-mm-dd (yyyy-mm-dd hh:mm for approved_at,
 * in UTC), a string cell for every text value, never a formula (ruling 3), or no cell when empty.
 */
function xlsxCell(cell: ExportCell): Cell {
  if (cell === null) return null
  switch (cell.type) {
    case 'number':
      return { type: Number, value: Number(cell.text) }
    case 'date':
      return { type: Date, value: utcMidnight(cell.text), format: DATE_FORMAT }
    case 'datetime':
      return { type: Date, value: new Date(cell.iso), format: DATE_TIME_FORMAT }
    case 'text':
      return { type: String, value: cell.text }
  }
}

function sheetData(table: ExportTable): SheetData {
  return [table.header.map((h) => ({ type: String, value: h })), ...table.rows.map((row) => row.map(xlsxCell))]
}

/** The XLSX file: sheets "Documents" and "Line items", the header row frozen. */
export async function buildXlsx(input: ExportInput): Promise<Uint8Array> {
  const { documents, lineItems } = exportTables(input)
  const blob = await writeXlsxFile([
    { data: sheetData(documents), sheet: 'Documents', stickyRowsCount: 1 },
    { data: sheetData(lineItems), sheet: 'Line items', stickyRowsCount: 1 },
  ]).toBlob()
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * A CSV field's text: a number or a date as stored, approved_at as ISO 8601 in UTC to the second
 * with a Z, and text with the formula guard (ruling 3, and the Lead's ruling on #39 that it covers
 * every value written as text, in any column).
 */
function csvText(cell: ExportCell): string {
  if (cell === null) return ''
  switch (cell.type) {
    case 'number':
    case 'date':
      return cell.text
    case 'datetime':
      return new Date(cell.iso).toISOString().replace(/\.\d{3}Z$/, 'Z')
    case 'text':
      return guardFormula(cell.text)
  }
}

const csvOf = (table: ExportTable) => toCsv([table.header, ...table.rows.map((row) => row.map(csvText))])

/** The CSV export: one zip holding documents.csv and line_items.csv, UTF-8 without a byte order mark. */
export function buildCsvZip(input: ExportInput): Uint8Array {
  const { documents, lineItems } = exportTables(input)
  return zipSync({
    'documents.csv': strToU8(csvOf(documents)),
    'line_items.csv': strToU8(csvOf(lineItems)),
  })
}
