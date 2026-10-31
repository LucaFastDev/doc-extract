// The CSV writer for export (PRD US-6.1 AC-5): RFC 4180 quoting, CRLF line ends. Plain TypeScript
// with no imports, so the demo can call it too (milestone 11).

/** The characters a spreadsheet may read as the start of a formula (Lead ruling 3 on #39). */
const FORMULA_START = /^[=+\-@\t\r]/

/**
 * A text value with a single quote put in front when it starts with =, +, -, @, a tab or a carriage
 * return, so a spreadsheet opening the file shows it as text instead of running it. Values come
 * from documents and are untrusted; parsed numbers and dates are never passed here.
 */
export function guardFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text
}

/**
 * One field, quoted when it holds a comma, a double quote, a CR or an LF (RFC 4180), and also when
 * it starts or ends with a space or a tab, which some readers would otherwise trim.
 */
export function csvField(value: string): string {
  return /[",\r\n]|^[ \t]|[ \t]$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The rows, the header first, each ended by CRLF. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => `${row.map(csvField).join(',')}\r\n`).join('')
}
