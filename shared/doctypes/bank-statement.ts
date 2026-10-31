import { add, formatAmount, sum, withinTolerance, type Decimal } from './decimal.ts'
import { capitalised, dateCheck, linePath, lineDateRangeCheck, type CheckContext } from './checks.ts'
import { checkU1, duplicateKey, type DuplicateKey } from './duplicate.ts'
import type { DocTypeDef } from './doctype.ts'
import { COMMON_FIELDS, read, recordTool, type CheckResult, type DocumentValues, type FieldDef, type Reading } from './fields.ts'

// The bank statement type (PRD section 4.1 Bank statement): its fields, its tool
// record_bank_statement, and its checks A1 to A3, D1, D2 and U1. Its lines are transactions,
// stored as line_items[i] like every type's. Account numbers and IBANs keep only their last four
// characters (OQ-29, index.ts).

export const BANK_STATEMENT_FIELDS: FieldDef[] = [
  ...COMMON_FIELDS,
  { name: 'bank_name', kind: 'text', description: 'The bank that issued the statement.' },
  { name: 'account_holder', kind: 'text', description: 'The account holder’s name (Kontoinhaber, titulaire), as printed.' },
  {
    name: 'account_number_last4',
    kind: 'text',
    description: 'The last four characters of the account number (Kontonummer, numéro de compte); never more than four.',
  },
  { name: 'iban_last4', kind: 'text', description: 'The last four characters of the IBAN, if printed; never more than four.' },
  { name: 'statement_period_start', kind: 'date', description: 'The first day the statement covers (from, vom, du).' },
  { name: 'statement_period_end', kind: 'date', description: 'The last day the statement covers (to, bis, au).' },
  { name: 'opening_balance', kind: 'amount', description: 'The balance at the start of the period (opening, previous balance, alter Kontostand); negative when overdrawn.' },
  { name: 'closing_balance', kind: 'amount', description: 'The balance at the end of the period (closing, new balance, neuer Kontostand); negative when overdrawn.' },
  { name: 'total_credits', kind: 'amount', description: 'The total paid in, as a positive amount (credits, Gutschriften, Haben), if printed.' },
  { name: 'total_debits', kind: 'amount', description: 'The total paid out, as a positive amount (debits, Belastungen, Soll), if printed.' },
]

export const BANK_STATEMENT_TRANSACTION_FIELDS: FieldDef[] = [
  { name: 'date', kind: 'date', description: 'The booking date of the transaction.' },
  { name: 'description', kind: 'text', description: 'The transaction’s text, as printed.' },
  { name: 'reference', kind: 'text', description: 'The transaction’s reference, if printed.' },
  { name: 'amount', kind: 'amount', description: 'The amount, signed: money in positive, money out negative.' },
  { name: 'balance', kind: 'amount', description: 'The running balance after the transaction, where printed.' },
]

export const RECORD_BANK_STATEMENT = recordTool({
  name: 'record_bank_statement',
  description:
    'Record the fields of a bank statement: a bank’s list of the transactions on one account over a period, with opening and closing balances. Give every field; for one the document does not show, give an empty value. Read only what is printed and never invent a value.',
  fields: BANK_STATEMENT_FIELDS,
  linesKey: 'transactions',
  linesDescription: 'The transactions in the order printed; an empty list when there are none.',
  lineFields: BANK_STATEMENT_TRANSACTION_FIELDS,
})

// Checks --------------------------------------------------------------------------------------

const valueOf = (r: Reading) => (r as { value: Decimal }).value
const textOf = (r: Reading) => (r as { text: string }).text

/** The transactions' amounts, or why a check cannot add them: one is missing or not an amount. */
function amounts(v: DocumentValues): { ok: Decimal[] } | { skipped: string } | { invalid: string } {
  const readings = v.line_items.map((line) => read(line.amount))
  const missing = readings.findIndex((r) => r.state === 'empty')
  if (missing >= 0) return { skipped: `transaction ${missing + 1} has no amount.` }
  const bad = readings.findIndex((r) => r.state === 'invalid')
  if (bad >= 0) return { invalid: `Transaction ${bad + 1}: amount "${textOf(readings[bad])}" is not an amount` }
  return { ok: readings.map(valueOf) }
}

/** A1: opening_balance + the sum of the transaction amounts = closing_balance. */
export function checkA1(v: DocumentValues, tolerance: Decimal): CheckResult {
  const field_paths = ['opening_balance', ...v.line_items.map((_, i) => linePath(i, 'amount')), 'closing_balance']
  const skipped = (why: string): CheckResult => ({ check_id: 'A1', status: 'skipped', field_paths, message: `Skipped: ${why}` })
  const fail = (message: string): CheckResult => ({ check_id: 'A1', status: 'fail', field_paths, message })

  const opening = read(v.fields.opening_balance)
  const closing = read(v.fields.closing_balance)
  if (opening.state === 'empty') return skipped('no opening balance is printed.')
  if (closing.state === 'empty') return skipped('no closing balance is printed.')
  const lines = amounts(v)
  if ('skipped' in lines) return skipped(lines.skipped)
  if (opening.state === 'invalid') return fail(`Opening balance "${opening.text}" is not an amount`)
  if (closing.state === 'invalid') return fail(`Closing balance "${closing.text}" is not an amount`)
  if ('invalid' in lines) return fail(lines.invalid)

  const moved = sum(lines.ok)
  const computed = add(opening.value, moved)
  if (withinTolerance(computed, closing.value, tolerance)) return { check_id: 'A1', status: 'pass', field_paths, message: null }
  return fail(
    `Opening balance ${formatAmount(opening.value)} + transactions ${formatAmount(moved)} = ${formatAmount(computed)}; closing balance is ${formatAmount(closing.value)}`,
  )
}

/**
 * A2: each transaction with a printed balance: previous balance + amount = balance. The previous
 * balance is the one printed on the line before, or the opening balance for the first, carried
 * forward over lines that print none; a line after an unknown balance is left out.
 */
export function checkA2(v: DocumentValues, tolerance: Decimal): CheckResult {
  const checked: string[] = []
  const failed: string[] = []
  const problems: string[] = []
  const opening = read(v.fields.opening_balance)
  let running: Decimal | null = opening.state === 'ok' ? opening.value : null

  v.line_items.forEach((line, i) => {
    const paths = [linePath(i, 'amount'), linePath(i, 'balance')]
    const amount = read(line.amount)
    const balance = read(line.balance)
    if (balance.state === 'invalid' || (balance.state === 'ok' && amount.state === 'invalid')) {
      const [label, r] = balance.state === 'invalid' ? ['balance', balance] : ['amount', amount]
      failed.push(...paths)
      problems.push(`Transaction ${i + 1}: ${label} "${textOf(r)}" is not an amount`)
      running = null
      return
    }
    if (balance.state === 'empty') {
      running = running && amount.state === 'ok' ? add(running, amount.value) : null
      return
    }
    if (running && amount.state === 'ok') {
      const computed = add(running, amount.value)
      if (withinTolerance(computed, balance.value, tolerance)) {
        checked.push(...paths)
      } else {
        failed.push(...paths)
        problems.push(
          `Transaction ${i + 1}: previous balance ${formatAmount(running)} + amount ${formatAmount(amount.value)} = ${formatAmount(computed)}; balance is ${formatAmount(balance.value)}`,
        )
      }
    }
    running = balance.value
  })

  if (problems.length > 0) return { check_id: 'A2', status: 'fail', field_paths: failed, message: problems.join('. ') }
  if (checked.length === 0) {
    const all = v.line_items.flatMap((_, i) => [linePath(i, 'amount'), linePath(i, 'balance')])
    return {
      check_id: 'A2',
      status: 'skipped',
      field_paths: all,
      message: 'Skipped: no transaction has a printed balance, an amount and a balance before it.',
    }
  }
  return { check_id: 'A2', status: 'pass', field_paths: checked, message: null }
}

/** A3: the positive amounts sum to total_credits, and the negative ones to −total_debits, where printed. */
export function checkA3(v: DocumentValues, tolerance: Decimal): CheckResult {
  const amountPaths = v.line_items.map((_, i) => linePath(i, 'amount'))
  const credits = read(v.fields.total_credits)
  const debits = read(v.fields.total_debits)
  const field_paths = [
    ...amountPaths,
    ...(credits.state !== 'empty' ? ['total_credits'] : []),
    ...(debits.state !== 'empty' ? ['total_debits'] : []),
  ]
  const skipped = (why: string): CheckResult => ({ check_id: 'A3', status: 'skipped', field_paths, message: `Skipped: ${why}` })
  const fail = (message: string): CheckResult => ({ check_id: 'A3', status: 'fail', field_paths, message })

  if (credits.state === 'empty' && debits.state === 'empty') {
    return { ...skipped('no total credits or total debits is printed.'), field_paths: [...amountPaths, 'total_credits', 'total_debits'] }
  }
  const lines = amounts(v)
  if ('skipped' in lines) return skipped(lines.skipped)
  for (const [label, r] of [['total credits', credits], ['total debits', debits]] as const) {
    if (r.state === 'invalid') return fail(`${capitalised(label)} "${r.text}" is not an amount`)
  }
  if ('invalid' in lines) return fail(lines.invalid)

  const problems: string[] = []
  if (credits.state === 'ok') {
    const paidIn = sum(lines.ok.filter((d) => d.units > 0n))
    if (!withinTolerance(paidIn, credits.value, tolerance)) {
      problems.push(`Credits sum to ${formatAmount(paidIn)}; total credits is ${formatAmount(credits.value)}`)
    }
  }
  if (debits.state === 'ok') {
    const out = sum(lines.ok.filter((d) => d.units < 0n))
    const paidOut = { units: -out.units, scale: out.scale }
    if (!withinTolerance(paidOut, debits.value, tolerance)) {
      problems.push(`Debits sum to ${formatAmount(paidOut)}; total debits is ${formatAmount(debits.value)}`)
    }
  }
  if (problems.length > 0) return fail(problems.join('. '))
  return { check_id: 'A3', status: 'pass', field_paths, message: null }
}

/** D1: statement_period_end ≥ statement_period_start, and neither is in the future. */
export function checkD1(v: DocumentValues, today: string): CheckResult {
  return dateCheck(
    'D1',
    v,
    today,
    [
      { name: 'statement_period_start', label: 'period start', notFuture: true },
      { name: 'statement_period_end', label: 'period end', notFuture: true },
    ],
    [['statement_period_start', 'statement_period_end']],
  )
}

/** D2: every transaction date is within the statement period. */
export function checkD2(v: DocumentValues, today: string): CheckResult {
  return lineDateRangeCheck(
    'D2',
    v,
    today,
    { name: 'date', label: 'date', lineLabel: 'transaction' },
    { name: 'statement_period_start', label: 'period start' },
    { name: 'statement_period_end', label: 'period end' },
  )
}

/** U1's key: the account (bank name and the last four of the account number, else of the IBAN) and the period. */
export function bankStatementDuplicateKey(v: DocumentValues): DuplicateKey {
  const account = v.fields.account_number_last4 ? 'account_number_last4' : 'iban_last4'
  return duplicateKey(
    'bank_statement',
    v,
    [
      { name: 'bank_name', kind: 'text' },
      { name: account, kind: 'text' },
      { name: 'statement_period_start', kind: 'date' },
      { name: 'statement_period_end', kind: 'date' },
    ],
    'bank, account and statement period',
  )
}

export function bankStatementChecks(v: DocumentValues, c: CheckContext): CheckResult[] {
  return [
    checkA1(v, c.tolerance),
    checkA2(v, c.tolerance),
    checkA3(v, c.tolerance),
    checkD1(v, c.today),
    checkD2(v, c.today),
    checkU1(bankStatementDuplicateKey(v), null),
  ]
}

export const BANK_STATEMENT: DocTypeDef = {
  tool: RECORD_BANK_STATEMENT,
  fields: BANK_STATEMENT_FIELDS,
  linesKey: 'transactions',
  lineFields: BANK_STATEMENT_TRANSACTION_FIELDS,
  checks: bankStatementChecks,
  duplicateKey: bankStatementDuplicateKey,
  flagsCurrency: true,
}
