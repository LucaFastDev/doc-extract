import { describe, expect, it } from 'vitest'
import { prepareResult } from '../../../shared/doctypes/index'
import { INVOICE_FIELDS } from '../../../shared/doctypes/invoice'
import type { StoredField } from '../../../shared/doctypes/review'
import { approveDocument, type ApprovalInput, type ApprovalOutcome, type ApproveDeps, type ApprovedDocument } from './approve'

// approve-document's steps (ARCHITECTURE.md section 6.1, PRD US-5.1 AC-5 and AC-6, OQ-11): the
// caller must be a member and the document must need review; the checks run again on the
// corrected values, and approve_document stores them and approves, or refuses while a failed
// check has no tick, naming it.

const WS = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

const f = (value: string, confidence = 0.95) => ({ value, confidence })

/**
 * An invoice as process-queue stores it: the line amounts sum to 100.00 and 100.00 + 19.00 tax is
 * the total of 119.00, but the subtotal was read as 120.00, so A2 and A3 fail.
 */
function invoiceRows(): StoredField[] {
  const input = {
    ...Object.fromEntries(INVOICE_FIELDS.map((d) => [d.name, f('')])),
    vendor_name: f('Acme GmbH'),
    invoice_number: f('INV-1042'),
    currency: f('EUR'),
    currency_as_printed: f('€'),
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
  const prepared = prepareResult('invoice', input, { confidenceThreshold: 0.8, amountTolerance: '0.01', today: '2026-10-31' })
  if (!prepared.ok) throw new Error(prepared.errors.join('; '))
  return prepared.fields.map((r) => ({ ...r, corrected_value: null }))
}

function correct(rows: StoredField[], path: string, value: string): StoredField[] {
  return rows.map((r) => (r.path === path ? { ...r, corrected_value: value } : r))
}

interface Fake extends ApproveDeps {
  sent: { id: string; actor: string; input: ApprovalInput } | null
}

function fake(
  o: { rows?: StoredField[]; doc?: Partial<ApprovedDocument> | null; member?: boolean; user?: string | null; outcome?: ApprovalOutcome } = {},
): Fake {
  const doc: ApprovedDocument | null =
    o.doc === null ? null : { id: DOC, workspace_id: WS, status: 'needs_review', doc_type: 'invoice', file_name: 'Invoice.pdf', ...o.doc }
  const f: Fake = {
    sent: null,
    userId: async () => (o.user === undefined ? USER : o.user),
    loadDocument: async () => doc,
    isMember: async () => o.member ?? true,
    loadFields: async () => o.rows ?? invoiceRows(),
    amountTolerance: async () => '0.01',
    now: () => new Date('2026-10-31T12:00:00Z'),
    approve: async (id, actor, input) => {
      f.sent = { id, actor, input }
      return o.outcome ?? { outcome: 'approved', approved_at: '2026-10-31T12:00:01Z' }
    },
  }
  return f
}

const check = (input: ApprovalInput | undefined, id: string) => input?.checks.find((c) => c.check_id === id)

describe('approve-document', () => {
  it('refuses a missing document id, a caller who is not signed in, and approves nothing', async () => {
    const deps = fake()
    expect((await approveDocument({}, deps)).status).toBe(400)
    expect((await approveDocument({ document_id: 'not-a-uuid' }, deps)).status).toBe(400)
    expect((await approveDocument({ document_id: DOC }, fake({ user: null }))).status).toBe(401)
    expect(deps.sent).toBeNull()
  })

  it('answers 404 to a non-member and for a document that does not exist, and approves nothing', async () => {
    for (const deps of [fake({ member: false }), fake({ doc: null })]) {
      const result = await approveDocument({ document_id: DOC }, deps)
      expect(result).toEqual({ status: 404, body: { error: 'This document does not exist.' } })
      expect(deps.sent).toBeNull()
    }
  })

  it('refuses with 409 a document that does not need review', async () => {
    for (const status of ['approved', 'queued', 'unsupported']) {
      const deps = fake({ doc: { status } })
      const result = await approveDocument({ document_id: DOC }, deps)
      expect(result.status).toBe(409)
      expect(deps.sent).toBeNull()
    }
  })

  it('re-runs the checks on the corrected values: a corrected subtotal passes A2 and A3', async () => {
    const stored = invoiceRows()
    // As extracted, A2 (lines sum to 100.00, subtotal 120.00) and A3 fail.
    expect(stored.find((r) => r.path === 'subtotal')?.flags).toEqual(['low_confidence', 'check_failed'])

    const deps = fake({ rows: correct(stored, 'subtotal', '100.00') })
    const result = await approveDocument({ document_id: DOC }, deps)
    expect(result).toEqual({
      status: 200,
      body: { document: { id: DOC, status: 'approved', approved_by: USER, approved_at: '2026-10-31T12:00:01Z' } },
    })
    expect(deps.sent?.actor).toBe(USER)
    expect(check(deps.sent?.input, 'A2')?.status).toBe('pass')
    expect(check(deps.sent?.input, 'A3')?.status).toBe('pass')
    // The values sent are what the checks read, the correction over the extracted value.
    expect(deps.sent?.input.values.subtotal).toBe('100.00')
    expect(deps.sent?.input.values.total).toBe('119.00')
    // Low confidence stays; the failed-check flag goes.
    expect(deps.sent?.input.flags.subtotal).toEqual(['low_confidence'])
    // U1 as it stands with no earlier document; approve_document runs it against the database.
    expect(check(deps.sent?.input, 'U1')?.status).toBe('pass')
    expect(deps.sent?.input.duplicate).toEqual({
      key: 'invoice|acmegmbh|inv1042',
      label: 'vendor and invoice number',
      flag_paths: ['vendor_name', 'invoice_number'],
    })
  })

  it('finds a check a correction broke, and flags its fields', async () => {
    const deps = fake({ rows: correct(correct(invoiceRows(), 'subtotal', '100.00'), 'line_items[0].quantity', '5') })
    await approveDocument({ document_id: DOC }, deps)
    expect(check(deps.sent?.input, 'A1')).toMatchObject({ status: 'fail', message: 'Line 1: 5 × 25.00 = 125.00; amount is 100.00' })
    expect(deps.sent?.input.flags['line_items[0].quantity']).toEqual(['check_failed'])
  })

  it('refuses with 409, naming them, while failed checks have no tick', async () => {
    const one = await approveDocument({ document_id: DOC }, fake({ outcome: { outcome: 'unticked', checks: ['A2'] } }))
    expect(one).toEqual({ status: 409, body: { error: 'Tick the failed check A2 before approving.', unticked: ['A2'] } })
    const three = await approveDocument({ document_id: DOC }, fake({ outcome: { outcome: 'unticked', checks: ['A2', 'A3', 'U1'] } }))
    expect(three).toEqual({
      status: 409,
      body: { error: 'Tick the failed checks A2, A3 and U1 before approving.', unticked: ['A2', 'A3', 'U1'] },
    })
  })

  it('refuses with 409 when the values changed meanwhile or the status moved on', async () => {
    const changed = await approveDocument({ document_id: DOC }, fake({ outcome: { outcome: 'changed' } }))
    expect(changed).toEqual({ status: 409, body: { error: 'Invoice.pdf changed while it was being approved. Try again.' } })
    const moved = await approveDocument({ document_id: DOC }, fake({ outcome: { outcome: 'wrong_status', status: 'approved' } }))
    expect(moved.status).toBe(409)
    const gone = await approveDocument({ document_id: DOC }, fake({ outcome: { outcome: 'not_found' } }))
    expect(gone.status).toBe(404)
  })

  it('flags the currency as guessed while the printed currency names no one currency, whatever the code', async () => {
    const deps = fake({ rows: correct(correct(invoiceRows(), 'currency_as_printed', '$'), 'currency', 'USD') })
    await approveDocument({ document_id: DOC }, deps)
    expect(deps.sent?.input.flags.currency).toEqual(['currency_guessed'])
  })
})
