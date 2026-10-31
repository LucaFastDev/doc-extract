import { describe, expect, it } from 'vitest'
import {
  BANK_STATEMENT_FIELDS,
  BANK_STATEMENT_TRANSACTION_FIELDS,
  bankStatementChecks,
  bankStatementDuplicateKey,
  checkA1,
  checkA2,
  checkA3,
  checkD1,
  checkD2,
  RECORD_BANK_STATEMENT,
} from './bank-statement'
import { parseDecimal, type Decimal } from './decimal'
import { checkU1 } from './duplicate'

// The bank statement type (PRD section 4.1 Bank statement): its fields and transactions, and its
// checks A1 to A3, D1, D2 and U1, each passing, failing with a message (US-4.1 AC-2), and skipped
// on empty inputs (OQ-43).

const CENT = parseDecimal('0.01') as Decimal
const TODAY = '2026-10-31'

const tx = (date: string | null, amount: string | null, balance: string | null = null) => ({ date, amount, balance })
const TRANSACTIONS = [tx('2026-09-03', '2400.00', '3900.00'), tx('2026-09-10', '-1200.00', '2700.00'), tx('2026-09-22', '-85.40', '2614.60')]

const statement = (fields: Record<string, string | null> = {}, lines: Record<string, string | null>[] = TRANSACTIONS) => ({
  fields: {
    bank_name: 'Example Mutual Bank',
    account_number_last4: '7781',
    iban_last4: '4321',
    statement_period_start: '2026-09-01',
    statement_period_end: '2026-09-30',
    opening_balance: '1500.00',
    closing_balance: '2614.60',
    total_credits: '2400.00',
    total_debits: '1285.40',
    ...fields,
  },
  line_items: lines,
})

describe('the bank statement field set', () => {
  it('has every field of PRD section 4.1 with its kind, and transactions as its lines', () => {
    expect(Object.fromEntries(BANK_STATEMENT_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      language: 'text',
      currency: 'text',
      currency_as_printed: 'text',
      bank_name: 'text',
      account_holder: 'text',
      account_number_last4: 'text',
      iban_last4: 'text',
      statement_period_start: 'date',
      statement_period_end: 'date',
      opening_balance: 'amount',
      closing_balance: 'amount',
      total_credits: 'amount',
      total_debits: 'amount',
    })
    expect(Object.fromEntries(BANK_STATEMENT_TRANSACTION_FIELDS.map((f) => [f.name, f.kind]))).toEqual({
      date: 'date',
      description: 'text',
      reference: 'text',
      amount: 'amount',
      balance: 'amount',
    })
    expect(Object.keys((RECORD_BANK_STATEMENT.input_schema as { properties: object }).properties)).toContain('transactions')
  })
})

describe('A1: opening_balance + sum of transaction amounts = closing_balance', () => {
  it('passes when it adds up', () => {
    expect(checkA1(statement(), CENT)).toEqual({
      check_id: 'A1',
      status: 'pass',
      field_paths: ['opening_balance', 'line_items[0].amount', 'line_items[1].amount', 'line_items[2].amount', 'closing_balance'],
      message: null,
    })
  })

  it('fails saying what did not add up', () => {
    expect(checkA1(statement({ closing_balance: '2600.00' }), CENT)).toMatchObject({
      status: 'fail',
      message: 'Opening balance 1,500.00 + transactions 1,114.60 = 2,614.60; closing balance is 2,600.00',
    })
  })

  it('is skipped with no opening or closing balance, or a transaction without an amount', () => {
    expect(checkA1(statement({ opening_balance: null }), CENT)).toMatchObject({ status: 'skipped', message: 'Skipped: no opening balance is printed.' })
    expect(checkA1(statement({ closing_balance: null }), CENT).status).toBe('skipped')
    expect(checkA1(statement({}, [tx('2026-09-03', null)]), CENT)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: transaction 1 has no amount.',
    })
  })
})

describe('A2: previous balance + amount = balance, where a balance is printed', () => {
  it('passes along the running balance, from the opening balance', () => {
    expect(checkA2(statement(), CENT)).toMatchObject({ check_id: 'A2', status: 'pass' })
  })

  it('carries the balance over a line that prints none', () => {
    const lines = [tx('2026-09-03', '100.00'), tx('2026-09-04', '-50.00', '1550.00')]
    expect(checkA2(statement({}, lines), CENT)).toMatchObject({
      status: 'pass',
      field_paths: ['line_items[1].amount', 'line_items[1].balance'],
    })
  })

  it('fails naming the transaction and its sum', () => {
    const lines = [tx('2026-09-03', '2400.00', '3900.00'), tx('2026-09-10', '-1200.00', '2600.00')]
    expect(checkA2(statement({}, lines), CENT)).toEqual({
      check_id: 'A2',
      status: 'fail',
      field_paths: ['line_items[1].amount', 'line_items[1].balance'],
      message: 'Transaction 2: previous balance 3,900.00 + amount -1,200.00 = 2,700.00; balance is 2,600.00',
    })
  })

  it('is skipped when no balance is printed, or none has a known balance before it', () => {
    expect(checkA2(statement({}, [tx('2026-09-03', '1.00')]), CENT)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no transaction has a printed balance, an amount and a balance before it.',
    })
    expect(checkA2(statement({ opening_balance: null }, [tx('2026-09-03', '1.00', '5.00')]), CENT).status).toBe('skipped')
  })
})

describe('A3: credits sum to total_credits and debits to total_debits, where printed', () => {
  it('passes when both add up', () => {
    expect(checkA3(statement(), CENT)).toMatchObject({ check_id: 'A3', status: 'pass' })
  })

  it('fails naming the total that does not add up', () => {
    expect(checkA3(statement({ total_debits: '1200.00' }), CENT)).toMatchObject({
      status: 'fail',
      message: 'Debits sum to 1,285.40; total debits is 1,200.00',
    })
    expect(checkA3(statement({ total_credits: '2500.00' }), CENT).message).toBe('Credits sum to 2,400.00; total credits is 2,500.00')
  })

  it('checks the one that is printed, and is skipped when neither is', () => {
    expect(checkA3(statement({ total_debits: null }), CENT)).toMatchObject({ status: 'pass' })
    expect(checkA3(statement({ total_credits: null, total_debits: null }), CENT)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no total credits or total debits is printed.',
    })
  })
})

describe('D1: period end ≥ period start, and neither in the future', () => {
  it('passes for a past period', () => {
    expect(checkD1(statement(), TODAY)).toEqual({
      check_id: 'D1',
      status: 'pass',
      field_paths: ['statement_period_start', 'statement_period_end'],
      message: null,
    })
  })

  it('fails an end before the start, a future end, or a date before 2000', () => {
    expect(checkD1(statement({ statement_period_end: '2026-08-31' }), TODAY).message).toBe(
      'Period end 2026-08-31 is before period start 2026-09-01',
    )
    expect(checkD1(statement({ statement_period_end: '2026-11-30' }), TODAY).message).toBe('Period end 2026-11-30 is in the future')
    expect(checkD1(statement({ statement_period_start: '1999-12-01' }), TODAY).message).toBe('Period start 1999-12-01 is before 2000-01-01')
  })

  it('is skipped when neither date is printed', () => {
    expect(checkD1(statement({ statement_period_start: null, statement_period_end: null }), TODAY).status).toBe('skipped')
  })
})

describe('D2: every transaction date is within the period', () => {
  it('passes when every date is within it', () => {
    expect(checkD2(statement(), TODAY)).toMatchObject({ check_id: 'D2', status: 'pass' })
  })

  it('fails naming each transaction out of the period, and flags it with the end it breaks', () => {
    const lines = [tx('2026-08-31', '1.00'), tx('2026-09-15', '1.00'), tx('2026-10-01', '1.00')]
    expect(checkD2(statement({}, lines), TODAY)).toEqual({
      check_id: 'D2',
      status: 'fail',
      field_paths: ['line_items[0].date', 'line_items[2].date', 'statement_period_start', 'statement_period_end'],
      message:
        'Transaction 1: date 2026-08-31 is before period start 2026-09-01. Transaction 3: date 2026-10-01 is after period end 2026-09-30',
    })
  })

  it('fails a transaction date that is not a date or before 2000', () => {
    expect(checkD2(statement({}, [tx('03.09.2026', '1.00')]), TODAY).message).toBe('Transaction 1: date "03.09.2026" is not a date')
    expect(checkD2(statement({ statement_period_start: null }, [tx('1999-09-03', '1.00')]), TODAY).message).toBe(
      'Transaction 1: date 1999-09-03 is before 2000-01-01',
    )
  })

  it('checks against the end that is printed, and is skipped when no date is printed at all', () => {
    expect(checkD2(statement({ statement_period_start: null }), TODAY).status).toBe('pass')
    expect(checkD2(statement({ statement_period_start: null, statement_period_end: null }, [tx(null, '1.00')]), TODAY)).toMatchObject({
      status: 'skipped',
      message: 'Skipped: no date, period start or period end is printed.',
    })
  })
})

describe('U1: same account (bank name and last four digits) and same period', () => {
  it('keys on the bank, the account number’s last four (else the IBAN’s) and the period', () => {
    expect(bankStatementDuplicateKey(statement()).key).toBe('bank_statement|examplemutualbank|7781|20260901|20260930')
    expect(bankStatementDuplicateKey(statement({ account_number_last4: null })).field_paths).toEqual([
      'bank_name',
      'iban_last4',
      'statement_period_start',
      'statement_period_end',
    ])
  })

  it('passes, fails on a match, and is skipped without a period', () => {
    expect(checkU1(bankStatementDuplicateKey(statement()), null).status).toBe('pass')
    expect(checkU1(bankStatementDuplicateKey(statement()), { file_name: 'sept.pdf', by: 'key' }).message).toBe(
      'Duplicate of "sept.pdf": the same bank, account and statement period.',
    )
    expect(checkU1(bankStatementDuplicateKey(statement({ statement_period_end: null })), null).status).toBe('skipped')
  })
})

describe('bankStatementChecks', () => {
  it('runs A1 to A3, D1, D2 and U1, in order', () => {
    expect(bankStatementChecks(statement(), { tolerance: CENT, today: TODAY }).map((c) => c.check_id)).toEqual([
      'A1',
      'A2',
      'A3',
      'D1',
      'D2',
      'U1',
    ])
  })
})
