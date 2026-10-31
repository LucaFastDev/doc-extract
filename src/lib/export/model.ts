import { parseDate, utcDate } from '@shared/doctypes/checks'
import { parseDecimal } from '@shared/doctypes/decimal'
import type { FieldKind } from '@shared/doctypes/fields'
import { DOC_TYPES, type DocType } from '@shared/doctypes/index'
import { currentValue, parseLinePath, type StoredField } from '@shared/doctypes/review'

// What an export holds (PRD US-6.1, OQ-13; Lead rulings 1 and 2 on #39), as plain data: the two
// tables, "Documents" and "Line items", with each cell's kind, which the XLSX and CSV writers in
// files.ts then write. Nothing here reads Supabase or imports React, so the demo can export its
// stored results the same way (milestone 11).

/** One approved document, as an export takes it: its values by field name and its lines in order. */
export interface ExportDocument {
  id: string
  fileName: string
  /** The approval time, as Postgres returns it (ISO 8601 with an offset); null for a demo sample, never approved. */
  approvedAt: string | null
  /** Every header field of the type; null or '' when it has no value. */
  fields: Record<string, string | null>
  /** The lines (a bank statement's transactions) in the order the review screen shows them. */
  lineItems: Record<string, string | null>[]
}

export interface ExportInput {
  docType: DocType
  documents: ExportDocument[]
}

/** null is an empty cell. A number's and a date's text is the value as stored. */
export type ExportCell =
  | null
  | { type: 'text'; text: string }
  | { type: 'number'; text: string }
  | { type: 'date'; text: string }
  | { type: 'datetime'; iso: string }

export interface ExportTable {
  header: string[]
  rows: ExportCell[][]
}

export type ExportFormat = 'xlsx' | 'csv'

/**
 * A value's cell (ruling 2): an amount, number or percent that parses is a number, kept as stored
 * (a percent of 19 stays 19); a full YYYY-MM-DD date is a date; anything else is text as written.
 */
export function cellFor(kind: FieldKind, value: string | null): ExportCell {
  if (value === null || value === '') return null
  if (kind === 'amount' || kind === 'number' || kind === 'percent') {
    return parseDecimal(value) ? { type: 'number', text: value.trim() } : { type: 'text', text: value }
  }
  if (kind === 'date') {
    const date = parseDate(value)
    return date ? { type: 'date', text: date } : { type: 'text', text: value }
  }
  return { type: 'text', text: value }
}

const text = (value: string): ExportCell => ({ type: 'text', text: value })

/**
 * The two tables (ruling 1): headers are the field names in the type's order, after document_id,
 * file_name and approved_at ("Documents") or document_id, file_name and position, from 1 ("Line
 * items"). Every field of the type has a column, even when every value is empty.
 */
export function exportTables(input: ExportInput): { documents: ExportTable; lineItems: ExportTable } {
  const def = DOC_TYPES[input.docType]
  const documents: ExportTable = {
    header: ['document_id', 'file_name', 'approved_at', ...def.fields.map((f) => f.name)],
    rows: input.documents.map((d) => [
      text(d.id),
      text(d.fileName),
      d.approvedAt === null ? null : { type: 'datetime', iso: d.approvedAt },
      ...def.fields.map((f) => cellFor(f.kind, d.fields[f.name] ?? null)),
    ]),
  }
  const lineItems: ExportTable = {
    header: ['document_id', 'file_name', 'position', ...def.lineFields.map((f) => f.name)],
    rows: input.documents.flatMap((d) =>
      d.lineItems.map((line, i): ExportCell[] => [
        text(d.id),
        text(d.fileName),
        { type: 'number', text: String(i + 1) },
        ...def.lineFields.map((f) => cellFor(f.kind, line[f.name] ?? null)),
      ]),
    ),
  }
  return { documents, lineItems }
}

/**
 * One document's export values from its extraction_fields rows (US-6.1 AC-2): the corrected value
 * where there is one and the extracted value otherwise. A deleted line has no rows left
 * (delete_line_item), and an added one has rows of its own (add_line_item), so both follow.
 */
export function exportDocument(
  docType: DocType,
  doc: { id: string; file_name: string; approved_at: string | null },
  rows: Pick<StoredField, 'path' | 'extracted_value' | 'corrected_value'>[],
): ExportDocument {
  const def = DOC_TYPES[docType]
  const fields: Record<string, string | null> = Object.fromEntries(def.fields.map((f) => [f.name, null]))
  const lines = new Map<number, Record<string, string | null>>()
  for (const row of rows) {
    const line = parseLinePath(row.path)
    if (!line) {
      if (row.path in fields) fields[row.path] = currentValue(row)
      continue
    }
    if (!lines.has(line.index)) lines.set(line.index, Object.fromEntries(def.lineFields.map((f) => [f.name, null])))
    const cells = lines.get(line.index)!
    if (line.name in cells) cells[line.name] = currentValue(row)
  }
  return {
    id: doc.id,
    fileName: doc.file_name,
    approvedAt: doc.approved_at,
    fields,
    lineItems: [...lines.entries()].sort(([a], [b]) => a - b).map(([, cells]) => cells),
  }
}

/** `<type>-export-<yyyy-mm-dd>.xlsx` or `.zip`, the type in kebab case, the date in UTC. */
export function exportFileName(docType: DocType, format: ExportFormat, now: Date): string {
  return `${docType.replace(/_/g, '-')}-export-${utcDate(now)}.${format === 'xlsx' ? 'xlsx' : 'zip'}`
}
