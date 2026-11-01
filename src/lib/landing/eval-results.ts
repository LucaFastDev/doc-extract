import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_TYPE_LABELS } from '@/lib/documents/upload'

// The accuracy tables of the landing page (PRD F15 AC-3, section 10; issue #45 criterion 4): the
// newest results file of each model in eval/results/, in the shape eval/README.md gives. Only the
// fields shown here are read.

const TYPES = Object.keys(DOC_TYPE_LABELS)
const FIRST_MODEL = 'claude-sonnet-5-5'

export interface AccuracyRow {
  type: string
  label: string
  header: string
  lineItems: string
  /** Header target / line items target, e.g. `95% / 90%`. */
  target: string
}

export interface AccuracyTable {
  model: string
  /** The run's UTC date, `yyyy-mm-dd`, as the results file gives it. */
  date: string
  rows: AccuracyRow[]
}

const percent = (share: number) => `${Math.round(share * 100)}%`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isShare(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1
}

// A kind's accuracy is null when the type has no values of that kind (eval/README.md).
function measure(value: unknown): { accuracy: number | null; target: number } | null {
  if (!isRecord(value) || !isShare(value.target)) return null
  if (value.accuracy !== null && !isShare(value.accuracy)) return null
  return { accuracy: value.accuracy, target: value.target }
}

function toTable(file: unknown): AccuracyTable | null {
  if (!isRecord(file) || typeof file.model !== 'string' || typeof file.date !== 'string' || !isRecord(file.types)) return null
  const rows: AccuracyRow[] = []
  for (const type of TYPES) {
    const entry = file.types[type]
    if (!isRecord(entry)) return null
    const header = measure(entry.header)
    const lineItems = measure(entry.line_items)
    if (!header || !lineItems) return null
    rows.push({
      type,
      label: DOC_TYPE_LABELS[type],
      header: header.accuracy === null ? '–' : percent(header.accuracy),
      lineItems: lineItems.accuracy === null ? '–' : percent(lineItems.accuracy),
      target: `${percent(header.target)} / ${percent(lineItems.target)}`,
    })
  }
  return { model: file.model, date: file.date, rows }
}

/**
 * One table per model, from that model's newest file by run date, `claude-sonnet-5-5` first and the
 * other models by name. A value that is not a results file throws, so a bad file fails the build
 * rather than quietly hiding the accuracy.
 */
export function accuracyTables(files: unknown[]): AccuracyTable[] {
  const newest = new Map<string, AccuracyTable>()
  for (const file of files) {
    const table = toTable(file)
    if (!table) throw new Error('An eval results file does not have the shape eval/README.md gives.')
    const seen = newest.get(table.model)
    if (!seen || table.date > seen.date) newest.set(table.model, table)
  }
  return [...newest.values()].sort((a, b) => {
    if (a.model === b.model) return 0
    if (a.model === FIRST_MODEL) return -1
    if (b.model === FIRST_MODEL) return 1
    return a.model < b.model ? -1 : 1
  })
}

/**
 * The parsed `.json` files of a folder; none for a folder that does not exist. A file that is not
 * JSON throws, naming it. Called while the landing page is built, never per request (ruling 2).
 */
export function readEvalResults(dir: string): unknown[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.map((name) => {
    try {
      return JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown
    } catch {
      throw new Error(`Eval results file ${name} is not valid JSON.`)
    }
  })
}

/** The committed results, `eval/results/` under the project root, which `next build` runs in. */
export function committedAccuracyTables(): AccuracyTable[] {
  return accuracyTables(readEvalResults(join(process.cwd(), 'eval', 'results')))
}
