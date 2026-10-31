import { strFromU8, unzipSync } from 'fflate'

// Reads a downloaded XLSX file for the export specs: each sheet by name, as rows of cell values,
// a shared string as its text and a number as written. An empty cell is null.

const unescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null

/** A column's letters as an index from 0: A is 0, Z 25, AA 26. */
function column(letters: string): number {
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
}

export function readXlsx(bytes: Uint8Array): Record<string, (string | null)[][]> {
  const files = unzipSync(bytes)
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '')
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  )
  const rels = text('xl/_rels/workbook.xml.rels')
  const sheets: Record<string, (string | null)[][]> = {}
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/>/g)) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${attr(m[1], 'r:id')}"[^>]*/>`).exec(rels)?.[0] ?? ''
    const xml = text(`xl/${(attr(rel, 'Target') ?? '').replace(/^\/?xl\//, '')}`)
    const rows: (string | null)[][] = []
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(attr(c[1], 'r')!)!
      const v = unescape(/<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1] ?? '')
      const r = Number(digits) - 1
      while (rows.length <= r) rows.push([])
      rows[r][column(letters)] = attr(c[1], 't') === 's' ? shared[Number(v)] : v
    }
    const width = Math.max(0, ...rows.map((r) => r.length))
    sheets[unescape(attr(m[1], 'name') ?? '')] = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null))
  }
  return sheets
}
