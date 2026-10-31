import type { ExportFormat } from './model'

// The browser side of an export (OQ-13): the two formats the user picks from, and handing the bytes
// files.ts built to the browser as a download. The export page and the demo's review screen share it.

export const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'xlsx', label: 'XLSX', hint: 'one file with the sheets Documents and Line items' },
  { value: 'csv', label: 'CSV', hint: 'a zip of documents.csv and line_items.csv' },
]

export const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'application/zip' }

/** Hands the bytes to the browser as a download under the given name. */
export function save(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
