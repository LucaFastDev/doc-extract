import { describe, expect, it } from 'vitest'
import type { CheckResult } from '@shared/doctypes/fields'
import { DOC_TYPES, prepareResult } from '@shared/doctypes/index'
import { INVOICE_FIELDS } from '@shared/doctypes/invoice'
import {
  addLine,
  applyCorrection,
  correctionFor,
  deleteLine,
  eventActor,
  fieldLabel,
  fieldName,
  flagReasons,
  formatTime,
  groupFields,
  lineCount,
  liveReview,
  storedReview,
  untickedFailures,
  type ReviewRow,
} from './review'

// The review screen's model (PRD US-4.1 AC-7, US-5.1 AC-2 to AC-5, OQ-44): corrections keep the
// extracted value, line items are added and deleted as the database does it, the checks re-run on
// the corrected values with U1 kept as stored, and flagged fields come first, each with its reason.

const INVOICE = DOC_TYPES.invoice
const CONTEXT = { amountTolerance: '0.01', today: '2026-10-31' }
const f = (value: string, confidence = 0.95) => ({ value, confidence })

/** An invoice whose subtotal was read as 120.00 with low confidence: A2 and A3 fail. Its currency prints only "$". */
function invoiceRows(): { rows: ReviewRow[]; stored: CheckResult[] } {
  const input = {
    ...Object.fromEntries(INVOICE_FIELDS.map((d) => [d.name, f('')])),
    vendor_name: f('Acme GmbH'),
    invoice_number: f('INV-1042'),
    currency: f('USD'),
    currency_as_printed: f('$'),
    invoice_date: f('2026-10-01'),
    subtotal: f('120.00', 0.5),
    discount_total: f('0.00'),
    shipping: f('0.00'),
    tax_total: f('19.00'),
    total: f('119.00'),
    line_items: [
      { description: f('Widgets'), item_code: f(''), quantity: f('4'), unit: f('pcs'), unit_price: f('25.00'), tax_rate: f(''), amount: f('100.00') },
    ],
  }
  const prepared = prepareResult('invoice', input, { confidenceThreshold: 0.8, ...CONTEXT })
  if (!prepared.ok) throw new Error(prepared.errors.join('; '))
  return { rows: prepared.fields.map((r) => ({ ...r, corrected_value: null })), stored: prepared.checks }
}

const row = (rows: ReviewRow[], path: string) => rows.find((r) => r.path === path)!
const status = (review: { checks: { check_id: string; status: string }[] }, id: string) => review.checks.find((c) => c.check_id === id)?.status

describe('corrections', () => {
  it('store what was typed and keep the extracted value beside it', () => {
    const { rows } = invoiceRows()
    const corrected = applyCorrection(rows, 'subtotal', correctionFor(row(rows, 'subtotal'), ' 100.00 '))
    expect(row(corrected, 'subtotal')).toMatchObject({ extracted_value: '120.00', corrected_value: '100.00' })
    // Nothing else changes.
    expect(corrected.filter((r) => r.path !== 'subtotal')).toEqual(rows.filter((r) => r.path !== 'subtotal'))
  })

  it('are no correction when the extracted value is typed again, and clear a field when it is emptied', () => {
    const { rows } = invoiceRows()
    expect(correctionFor(row(rows, 'subtotal'), '120.00')).toBeNull()
    expect(correctionFor(row(rows, 'subtotal'), '')).toBe('')
    // A field that was empty stays uncorrected when left empty.
    expect(correctionFor(row(rows, 'due_date'), '  ')).toBeNull()
  })

  it('keep only the last four characters of a card, account or IBAN number (OQ-29)', () => {
    expect(correctionFor({ path: 'card_last4', extracted_value: '1111' }, '4111 1111 1111 1234')).toBe('1234')
    expect(correctionFor({ path: 'line_items[0].description', extracted_value: null }, '4111 1111')).toBe('4111 1111')
  })
})

describe('line items', () => {
  it('are added empty after a line, with every cell of the type, moving the later lines down', () => {
    const { rows } = invoiceRows()
    const added = addLine(addLine(rows, INVOICE.lineFields, 0), INVOICE.lineFields, -1)
    expect(lineCount(added)).toBe(3)
    expect(row(added, 'line_items[1].description').extracted_value).toBe('Widgets')
    expect(row(added, 'line_items[0].amount')).toEqual({
      path: 'line_items[0].amount',
      kind: 'amount',
      extracted_value: null,
      corrected_value: null,
      confidence: null,
      flags: [],
    })
    expect(added.filter((r) => r.path.startsWith('line_items[2].')).map((r) => r.path.split('.')[1])).toEqual(INVOICE.lineFields.map((l) => l.name))
  })

  it('are deleted with every cell, moving the later lines up; the other lines keep their originals and corrections', () => {
    const { rows } = invoiceRows()
    let edited = addLine(rows, INVOICE.lineFields, 0)
    edited = applyCorrection(edited, 'line_items[0].quantity', '5')
    edited = applyCorrection(edited, 'line_items[1].description', 'Freight')
    const deleted = deleteLine(edited, 0)
    expect(lineCount(deleted)).toBe(1)
    expect(row(deleted, 'line_items[0].description')).toMatchObject({ extracted_value: null, corrected_value: 'Freight' })
    expect(deleted.some((r) => r.path.startsWith('line_items[1].'))).toBe(false)
    expect(deleteLine(rows, 0).filter((r) => r.path.startsWith('line_items['))).toEqual([])
  })
})

describe('the live re-check (US-4.1 AC-7)', () => {
  it('re-runs the checks on the corrected values: a corrected subtotal passes A2 and A3 and loses its failed-check flag', () => {
    const { rows, stored } = invoiceRows()
    const before = liveReview(INVOICE, rows, stored, CONTEXT)
    expect([status(before, 'A2'), status(before, 'A3')]).toEqual(['fail', 'fail'])
    expect(before.flags.subtotal).toEqual(['low_confidence', 'check_failed'])

    const after = liveReview(INVOICE, applyCorrection(rows, 'subtotal', '100.00'), stored, CONTEXT)
    expect([status(after, 'A2'), status(after, 'A3')]).toEqual(['pass', 'pass'])
    expect(after.flags.subtotal).toEqual(['low_confidence'])
  })

  it('fails a check a correction breaks, with its message', () => {
    const { rows, stored } = invoiceRows()
    const review = liveReview(INVOICE, applyCorrection(rows, 'line_items[0].quantity', '5'), stored, CONTEXT)
    expect(review.checks.find((c) => c.check_id === 'A1')).toMatchObject({ status: 'fail', message: 'Line 1: 5 × 25.00 = 125.00; amount is 100.00' })
  })

  it('treats an added empty line as the checks do: A2 is skipped until it has an amount', () => {
    const { rows, stored } = invoiceRows()
    const added = addLine(applyCorrection(rows, 'subtotal', '100.00'), INVOICE.lineFields, 0)
    expect(status(liveReview(INVOICE, added, stored, CONTEXT), 'A2')).toBe('skipped')
    const filled = applyCorrection(added, 'line_items[1].amount', '0.00')
    expect(status(liveReview(INVOICE, filled, stored, CONTEXT), 'A2')).toBe('pass')
  })

  it('keeps U1 and its duplicate flags as stored, whatever is corrected (Lead ruling 2 on #32)', () => {
    const { rows, stored } = invoiceRows()
    const u1 = { check_id: 'U1', status: 'fail' as const, field_paths: ['vendor_name', 'invoice_number'], message: 'Duplicate of "a.pdf": the same vendor and invoice number.' }
    const flagged = rows.map((r) => (u1.field_paths.includes(r.path) ? { ...r, flags: [...r.flags, 'duplicate'] } : r))
    const review = liveReview(INVOICE, applyCorrection(flagged, 'invoice_number', 'INV-9'), [...stored.filter((c) => c.check_id !== 'U1'), u1], CONTEXT)
    expect(review.checks.find((c) => c.check_id === 'U1')).toEqual(u1)
    expect(review.flags.invoice_number).toEqual(['duplicate'])
  })

  it('names the failed checks without a tick; low confidence and a guessed currency do not count (OQ-11)', () => {
    const { rows, stored } = invoiceRows()
    const review = liveReview(INVOICE, rows, stored, CONTEXT)
    expect(untickedFailures(review.checks, new Set())).toEqual(['A2', 'A3'])
    expect(untickedFailures(review.checks, new Set(['A2']))).toEqual(['A3'])
    expect(untickedFailures(review.checks, new Set(['A2', 'A3']))).toEqual([])
  })

  it('shows an approved document as stored', () => {
    const { rows, stored } = invoiceRows()
    expect(storedReview(rows, stored)).toEqual({ checks: stored, flags: Object.fromEntries(rows.map((r) => [r.path, r.flags])) })
  })
})

describe('flagged fields first (US-5.1 AC-2, AC-3)', () => {
  it('lists failed checks, then low confidence, then duplicates, then guessed currencies, then the rest in the type’s order', () => {
    const { rows, stored } = invoiceRows()
    const withDuplicate = rows.map((r) => (r.path === 'invoice_number' ? { ...r, flags: ['duplicate'] } : r))
    const lowAmount = applyCorrection(withDuplicate, 'subtotal', '100.00').map((r) =>
      r.path === 'line_items[0].amount' ? { ...r, flags: ['low_confidence'], confidence: 0.4 } : r,
    )
    const { flags } = liveReview(INVOICE, lowAmount, stored, CONTEXT)
    const groups = groupFields(INVOICE, lowAmount, flags)
    expect(groups.flagged.map((r) => r.path)).toEqual(['subtotal', 'line_items[0].amount', 'invoice_number', 'currency'])
    expect(groups.fields[0].path).toBe('language')
    expect(groups.fields.some((r) => groups.flagged.includes(r))).toBe(false)
    // A flagged cell is listed once, in the flagged group, not in its line.
    expect(groups.lines).toHaveLength(1)
    expect(groups.lines[0].map((r) => r.path)).toEqual(
      INVOICE.lineFields.filter((l) => l.name !== 'amount').map((l) => `line_items[0].${l.name}`),
    )
  })

  it('gives each flag its reason', () => {
    const { rows, stored } = invoiceRows()
    const review = liveReview(INVOICE, rows, stored, CONTEXT)
    expect(flagReasons(row(rows, 'subtotal'), review.flags.subtotal, review.checks, rows)).toEqual([
      'A2: Line items sum to 100.00; subtotal is 120.00',
      'A3: Subtotal 120.00 − discount 0.00 + shipping 0.00 + tax 19.00 = 139.00; total is 119.00',
      'Low confidence (50%)',
    ])
    expect(flagReasons(row(rows, 'currency'), review.flags.currency, review.checks, rows)).toEqual([
      'Currency guessed: only “$” is printed, which several currencies use',
    ])
  })
})

describe('labels', () => {
  it('give times in UTC, and who did each thing in the history', () => {
    expect(formatTime('2026-10-31T14:05:09Z')).toBe('31 Oct 2026, 14:05 UTC')
    const people = { u1: 'Ada' }
    expect(eventActor({ kind: 'approved', actor: 'u1' }, people)).toBe('Ada')
    expect(eventActor({ kind: 'extracted', actor: null }, people)).toBe('Claude')
    expect(eventActor({ kind: 'reopened', actor: null }, people)).toBe('a deleted user')
  })

  it('names fields and line cells for people', () => {
    expect(fieldName('vendor_tax_id')).toBe('Vendor tax ID')
    expect(fieldName('iban_last4')).toBe('IBAN (last 4)')
    expect(fieldLabel(INVOICE, 'line_items[1].unit_price')).toBe('Line 2 · Unit price')
    expect(fieldLabel(DOC_TYPES.bank_statement, 'line_items[0].date')).toBe('Transaction 1 · Date')
  })
})
