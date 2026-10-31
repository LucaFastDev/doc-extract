import { add, formatAmount, formatNumber, multiply, subtract, sum, withinTolerance, type Decimal } from './decimal.ts'
import { read, type CheckResult, type DocumentValues, type Reading } from './fields.ts'

// The kinds of check the six types share (PRD section 4.1, US-4.1): a product on each line, a sum
// of a line column, a formula over header amounts, and the date sanity checks of section 4.2
// (OQ-6). Each type names its fields and labels; a check whose inputs are empty is skipped (OQ-43).

export const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const linePath = (i: number, name: string) => `line_items[${i}].${name}`

const valueOf = (r: Reading) => (r as { value: Decimal }).value
const textOf = (r: Reading) => (r as { text: string }).text

/** "an amount" or "a number", for a value that is neither. */
const article = (kind: 'amount' | 'number') => (kind === 'amount' ? 'an amount' : 'a number')

/** What every check of a type is given: the arithmetic tolerance (OQ-7) and today's UTC date (OQ-6). */
export interface CheckContext {
  tolerance: Decimal
  /** YYYY-MM-DD, in UTC. */
  today: string
}

/** On each line, quantity × unit_price = amount. Lines missing any of the three are left out. */
export function lineProductCheck(id: string, v: DocumentValues, tolerance: Decimal): CheckResult {
  const all: string[] = []
  const checked: string[] = []
  const failed: string[] = []
  const problems: string[] = []

  v.line_items.forEach((line, i) => {
    const paths = ['quantity', 'unit_price', 'amount'].map((n) => linePath(i, n))
    all.push(...paths)
    const inputs: [string, 'amount' | 'number', Reading][] = [
      ['quantity', 'number', read(line.quantity)],
      ['unit price', 'amount', read(line.unit_price)],
      ['amount', 'amount', read(line.amount)],
    ]
    if (inputs.some(([, , r]) => r.state === 'empty')) return
    const invalid = inputs.find(([, , r]) => r.state === 'invalid')
    if (invalid) {
      failed.push(...paths)
      problems.push(`Line ${i + 1}: ${invalid[0]} "${textOf(invalid[2])}" is not ${article(invalid[1])}`)
      return
    }
    const [q, p, a] = inputs.map(([, , r]) => valueOf(r))
    const product = multiply(q, p)
    if (withinTolerance(product, a, tolerance)) {
      checked.push(...paths)
    } else {
      failed.push(...paths)
      problems.push(`Line ${i + 1}: ${formatNumber(q)} × ${formatAmount(p)} = ${formatAmount(product)}; amount is ${formatAmount(a)}`)
    }
  })

  if (problems.length > 0) return { check_id: id, status: 'fail', field_paths: failed, message: problems.join('. ') }
  if (checked.length === 0) {
    return { check_id: id, status: 'skipped', field_paths: all, message: 'Skipped: no line has a quantity, a unit price and an amount.' }
  }
  return { check_id: id, status: 'pass', field_paths: checked, message: null }
}

export interface LineSum {
  /** The line column summed, such as amount. */
  column: string
  /** The header field it must equal, such as subtotal. */
  total: string
  kind: 'amount' | 'number'
  /** "Line items sum to …" and "line 2 has no amount". */
  columnLabel: string
  totalLabel: string
  /** One line, "line" or "transaction"; all of them, "line items" or "transactions". */
  lineLabel: string
  linesLabel: string
}

/** The lines' column sums to a header total: line amounts to the subtotal, deliveries to the total quantity. */
export function lineSumCheck(id: string, v: DocumentValues, tolerance: Decimal, s: LineSum): CheckResult {
  const columnPaths = v.line_items.map((_, i) => linePath(i, s.column))
  const field_paths = [...columnPaths, s.total]
  const skipped = (why: string): CheckResult => ({ check_id: id, status: 'skipped', field_paths, message: `Skipped: ${why}` })
  const fail = (message: string): CheckResult => ({ check_id: id, status: 'fail', field_paths, message })
  const format = s.kind === 'amount' ? formatAmount : formatNumber

  if (v.line_items.length === 0) return skipped(`there are no ${s.linesLabel}.`)
  const total = read(v.fields[s.total])
  if (total.state === 'empty') return skipped(`no ${s.totalLabel} is printed.`)
  const values = v.line_items.map((line) => read(line[s.column]))
  const missing = values.findIndex((r) => r.state === 'empty')
  if (missing >= 0) return skipped(`${s.lineLabel} ${missing + 1} has no ${s.columnLabel}.`)
  if (total.state === 'invalid') return fail(`${capitalised(s.totalLabel)} "${total.text}" is not ${article(s.kind)}`)
  const bad = values.findIndex((r) => r.state === 'invalid')
  if (bad >= 0) return fail(`${capitalised(s.lineLabel)} ${bad + 1}: ${s.columnLabel} "${textOf(values[bad])}" is not ${article(s.kind)}`)

  const added = sum(values.map(valueOf))
  if (withinTolerance(added, total.value, tolerance)) return { check_id: id, status: 'pass', field_paths, message: null }
  return fail(`${capitalised(s.linesLabel)} sum to ${format(added)}; ${s.totalLabel} is ${format(total.value)}`)
}

/** The A2 of an invoice, receipt, purchase order and quote: the line amounts sum to the subtotal. */
export function subtotalCheck(id: string, v: DocumentValues, tolerance: Decimal): CheckResult {
  return lineSumCheck(id, v, tolerance, {
    column: 'amount',
    total: 'subtotal',
    kind: 'amount',
    columnLabel: 'amount',
    totalLabel: 'subtotal',
    lineLabel: 'line',
    linesLabel: 'line items',
  })
}

export interface Term {
  name: string
  label: string
  sign: '+' | '−'
}

/** A check of the form first ± terms… = result over header amounts. Skipped when any is not printed. */
export function formulaCheck(
  id: string,
  v: DocumentValues,
  tolerance: Decimal,
  first: Omit<Term, 'sign'>,
  terms: Term[],
  result: Omit<Term, 'sign'>,
): CheckResult {
  const parts = [first, ...terms, result]
  const field_paths = parts.map((p) => p.name)
  const readings = parts.map((p) => read(v.fields[p.name]))

  const empty = readings.findIndex((r) => r.state === 'empty')
  if (empty >= 0) {
    return { check_id: id, status: 'skipped', field_paths, message: `Skipped: no ${parts[empty].label} is printed.` }
  }
  const invalid = readings.findIndex((r) => r.state === 'invalid')
  if (invalid >= 0) {
    return { check_id: id, status: 'fail', field_paths, message: `${capitalised(parts[invalid].label)} "${textOf(readings[invalid])}" is not an amount` }
  }

  const values = readings.map(valueOf)
  let computed = values[0]
  terms.forEach((t, i) => {
    computed = t.sign === '+' ? add(computed, values[i + 1]) : subtract(computed, values[i + 1])
  })
  const actual = values[values.length - 1]
  if (withinTolerance(computed, actual, tolerance)) return { check_id: id, status: 'pass', field_paths, message: null }

  const formula = [
    `${capitalised(first.label)} ${formatAmount(values[0])}`,
    ...terms.map((t, i) => `${t.sign} ${t.label} ${formatAmount(values[i + 1])}`),
  ].join(' ')
  return {
    check_id: id,
    status: 'fail',
    field_paths,
    message: `${formula} = ${formatAmount(computed)}; ${result.label} is ${formatAmount(actual)}`,
  }
}

// Dates (PRD section 4.2, OQ-6) -----------------------------------------------------------------

/** No date on a document comes before this. */
export const EARLIEST_DATE = '2000-01-01'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A YYYY-MM-DD string that is a real calendar date; null for anything else. */
export function parseDate(text: string): string | null {
  const s = text.trim()
  const m = ISO_DATE.exec(s)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : null
}

/** Today's date in UTC, as the checks compare it. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** The latest date that is not in the future: one day after today, allowing for time zones (OQ-6). */
export function latestDate(today: string): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return utcDate(d)
}

export interface DateField {
  name: string
  label: string
  /** The check says this date is not in the future. */
  notFuture?: boolean
}

/** A printed date read for a check: the date, or what is wrong with it after its label. */
interface DateReading {
  path: string
  label: string
  date: string | null
  /** Such as `1999-12-31 is before 2000-01-01`; null when the date is sane. */
  issue: string | null
}

function readDate(path: string, label: string, value: string | null | undefined, notFuture: boolean, today: string): DateReading | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const date = parseDate(value)
  if (!date) return { path, label, date: null, issue: `"${value.trim()}" is not a date` }
  if (date < EARLIEST_DATE) return { path, label, date, issue: `${date} is before ${EARLIEST_DATE}` }
  if (notFuture && date > latestDate(today)) return { path, label, date, issue: `${date} is in the future` }
  return { path, label, date, issue: null }
}

/**
 * A D check over header dates: each printed date is a real date, not before 2000-01-01 and, where
 * the check says so, not more than a day in the future; and each ordering rule [earlier, later]
 * holds where both are printed. Skipped when every date is empty (Lead ruling 5 on #27).
 */
export function dateCheck(id: string, v: DocumentValues, today: string, dates: DateField[], order: [string, string][] = []): CheckResult {
  const field_paths = dates.map((d) => d.name)
  const readings = dates.map((d) => readDate(d.name, d.label, v.fields[d.name], d.notFuture ?? false, today))
  const present = readings.filter((r): r is DateReading => r !== null)
  if (present.length === 0) {
    const labels = dates.map((d) => d.label)
    const what = labels.length === 1 ? `no ${labels[0]} is printed` : `none of ${labels.slice(0, -1).join(', ')} and ${labels.at(-1)} is printed`
    return { check_id: id, status: 'skipped', field_paths, message: `Skipped: ${what}.` }
  }

  const problems = present.filter((r) => r.issue).map((r) => `${capitalised(r.label)} ${r.issue}`)
  const byName = Object.fromEntries(dates.map((d, i) => [d.name, readings[i]]))
  for (const [earlier, later] of order) {
    const a = byName[earlier]
    const b = byName[later]
    if (a?.date && b?.date && b.date < a.date) problems.push(`${capitalised(b.label)} ${b.date} is before ${a.label} ${a.date}`)
  }
  if (problems.length > 0) return { check_id: id, status: 'fail', field_paths, message: problems.join('. ') }
  return { check_id: id, status: 'pass', field_paths, message: null }
}

/**
 * A D check of a line column against a header range, such as every transaction date within the
 * statement period. Each printed date is a real date, not before 2000-01-01, and within whichever
 * ends of the range are printed. A failure names the lines out of range and the range's fields.
 */
export function lineDateRangeCheck(
  id: string,
  v: DocumentValues,
  today: string,
  column: { name: string; label: string; lineLabel: string },
  start: { name: string; label: string },
  end: { name: string; label: string },
): CheckResult {
  const linePaths = v.line_items.map((_, i) => linePath(i, column.name))
  const field_paths = [...linePaths, start.name, end.name]
  const from = readDate(start.name, start.label, v.fields[start.name], false, today)
  const to = readDate(end.name, end.label, v.fields[end.name], false, today)
  const lines = v.line_items.map((line, i) => readDate(linePath(i, column.name), column.label, line[column.name], false, today))

  if (!from && !to && lines.every((l) => l === null)) {
    return { check_id: id, status: 'skipped', field_paths, message: `Skipped: no ${column.label}, ${start.label} or ${end.label} is printed.` }
  }

  const problems: string[] = []
  const failed = new Set<string>()
  for (const r of [from, to]) {
    if (r?.issue) {
      problems.push(`${capitalised(r.label)} ${r.issue}`)
      failed.add(r.path)
    }
  }
  lines.forEach((l, i) => {
    if (!l) return
    if (l.issue) {
      problems.push(`${capitalised(column.lineLabel)} ${i + 1}: ${column.label} ${l.issue}`)
      failed.add(l.path)
      return
    }
    const date = l.date as string
    if (from?.date && date < from.date) {
      problems.push(`${capitalised(column.lineLabel)} ${i + 1}: ${column.label} ${date} is before ${start.label} ${from.date}`)
      failed.add(l.path).add(start.name)
    } else if (to?.date && date > to.date) {
      problems.push(`${capitalised(column.lineLabel)} ${i + 1}: ${column.label} ${date} is after ${end.label} ${to.date}`)
      failed.add(l.path).add(end.name)
    }
  })
  if (problems.length > 0) {
    return { check_id: id, status: 'fail', field_paths: field_paths.filter((p) => failed.has(p)), message: problems.join('. ') }
  }
  return { check_id: id, status: 'pass', field_paths, message: null }
}
