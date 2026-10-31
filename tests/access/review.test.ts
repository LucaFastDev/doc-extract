import { randomUUID } from 'node:crypto'
import { FunctionsHttpError } from '@supabase/supabase-js'
import type pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { utcDate } from '../../shared/doctypes/checks'
import { DOC_TYPES, prepareResult } from '../../shared/doctypes/index'
import { INVOICE_FIELDS } from '../../shared/doctypes/invoice'
import { deleteDocument } from '../../src/lib/documents/delete'
import { asServiceRole, asUser, rolledBack, withDb } from './local-db'
import { addMember, adminClient, anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// The review screen's database side (milestone 7, ARCHITECTURE.md sections 4.1, 4.2, 6.1 and 6.2,
// PRD F5, US-1.2 AC-4 to AC-6, F19; OQ-1, OQ-11, OQ-12, OQ-20, OQ-44, Lead rulings 1 and 2 on
// #32): corrections, line items, ticks, approve-document, reopen, type change and delete. Each is
// refused to a non-member, to anon and in the wrong status. Calls that queue a document run in a
// transaction that is rolled back, so the cron job never takes them.

type Db = pg.Client

const PDF = new TextEncoder().encode('%PDF-1.7\n%test\n')
const f = (value: string, confidence = 0.95) => ({ value, confidence })

/** Sets the workspace's pages this month and the user's lifetime pages to 0, so these tests never meet a limit. */
async function freeAllowance(db: Db, ws: string, user: string) {
  await db.query("update public.page_usage set pages_used = 0 where workspace_id = $1 and period_start = date_trunc('month', now() at time zone 'utc')::date", [ws])
  await db.query('update public.account_page_usage set pages_used = 0 where user_id = $1', [user])
}

interface InvoiceOptions {
  subtotal?: string
  invoiceNumber?: string
  status?: 'needs_review' | 'approved'
  file_name?: string
  sha256?: string
  /** Upload a file to the document's storage path while it is uploading. */
  withFile?: boolean
}

/**
 * An invoice as process-queue leaves it: one page counted, then recorded by record_extraction. Its
 * line amounts sum to 100.00 and 100.00 + 19.00 tax is its total of 119.00; a subtotal other than
 * 100.00 fails A2 and A3.
 */
async function extractedInvoice(user: TestUser, ws: string, o: InvoiceOptions = {}): Promise<{ id: string; storage_path: string }> {
  const file_name = o.file_name ?? `Invoice ${randomUUID().slice(0, 8)}.pdf`
  const doc = await createDocument(user, ws, { file_name, mime_type: 'application/pdf', byte_size: PDF.length })
  if (o.withFile) {
    const { error } = await user.client.storage.from('documents').upload(doc.storage_path, PDF, { contentType: 'application/pdf' })
    if (error) throw error
  }
  const input = {
    ...Object.fromEntries(INVOICE_FIELDS.map((d) => [d.name, f('')])),
    vendor_name: f('Acme GmbH'),
    invoice_number: f(o.invoiceNumber ?? `INV-${randomUUID().slice(0, 8)}`),
    currency: f('EUR'),
    currency_as_printed: f('€'),
    invoice_date: f('2026-10-01'),
    subtotal: f(o.subtotal ?? '100.00'),
    discount_total: f('0.00'),
    shipping: f('0.00'),
    tax_total: f('19.00'),
    total: f('119.00'),
    line_items: [
      { description: f('Widgets'), item_code: f(''), quantity: f('4'), unit: f('pcs'), unit_price: f('25.00'), tax_rate: f(''), amount: f('100.00') },
    ],
  }
  const prepared = prepareResult('invoice', input, { confidenceThreshold: 0.8, amountTolerance: '0.01', today: utcDate(new Date()) })
  if (!prepared.ok) throw new Error(prepared.errors.join('; '))

  await withDb(async (db) => {
    await db.query('update public.documents set page_count = 1, sha256 = $2 where id = $1', [doc.id, o.sha256 ?? randomUUID()])
    await db.query('begin')
    await freeAllowance(db, ws, user.id)
    await asServiceRole(db)
    const reserved = await db.query<{ ok: boolean }>('select public.reserve_pages($1) as ok', [doc.id])
    if (!reserved.rows[0].ok) throw new Error('reserve_pages refused the test document')
    await db.query('reset role')
    await db.query("update public.documents set status = 'processing' where id = $1", [doc.id])
    await asServiceRole(db)
    await db.query('select public.record_extraction($1, null, $2)', [
      doc.id,
      {
        outcome: 'ok',
        status: 'needs_review',
        model: 'claude-sonnet-5-5',
        prompt_version: 'test',
        tool_name: 'record_invoice',
        input_tokens: 1000,
        output_tokens: 200,
        cost_usd: 0.004,
        doc_type: 'invoice',
        fields: prepared.fields,
        checks: prepared.checks,
        duplicate: { key: prepared.duplicate.key, label: prepared.duplicate.label },
      },
    ])
    await db.query('reset role')
    if (o.status === 'approved') await db.query("update public.documents set status = 'approved' where id = $1", [doc.id])
    await db.query('commit')
  })
  return doc
}

async function documentRow(db: Db, id: string) {
  const { rows } = await db.query(
    `select status, doc_type, doc_type_source, duplicate_key, duplicate_of, approved_by, approved_at, pages_reserved, attempts
     from public.documents where id = $1`,
    [id],
  )
  return rows[0]
}

async function field(db: Db, id: string, path: string) {
  const { rows } = await db.query(
    'select extracted_value, corrected_value, corrected_by, corrected_at is not null as corrected, confidence, flags from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return rows[0]
}

async function lineCells(db: Db, id: string): Promise<Record<string, string | null>> {
  const { rows } = await db.query<{ path: string; value: string | null }>(
    "select path, coalesce(corrected_value, extracted_value) as value from public.extraction_fields where document_id = $1 and path like 'line_items[%' order by path",
    [id],
  )
  return Object.fromEntries(rows.map((r) => [r.path, r.value]))
}

async function usage(db: Db, ws: string, user: string) {
  const w = await db.query(
    "select pages_used from public.page_usage where workspace_id = $1 and period_start = date_trunc('month', now() at time zone 'utc')::date",
    [ws],
  )
  const a = await db.query('select pages_used from public.account_page_usage where user_id = $1', [user])
  return { workspace: w.rows[0]?.pages_used ?? 0, account: a.rows[0]?.pages_used ?? 0 }
}

/** The SQLSTATE a call as the user raises, or null when it succeeds. */
async function codeOf(db: Db, userId: string, sql: string, values: unknown[]): Promise<string | null> {
  await db.query('savepoint attempt')
  await asUser(db, userId)
  try {
    await db.query(sql, values)
    return null
  } catch (e) {
    return (e as { code: string }).code
  } finally {
    await db.query('rollback to savepoint attempt')
    await db.query('reset role')
  }
}

describe('the review RPCs', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
  })

  describe('corrections (OQ-44)', () => {
    it('let a member correct a field of a document that needs review: the extracted value stays, the audit is set', async () => {
      const { id } = await extractedInvoice(owner, ws, { subtotal: '120.00' })
      const { data, error } = await member.client
        .from('extraction_fields')
        .update({ corrected_value: '100.00' })
        .eq('document_id', id)
        .eq('path', 'subtotal')
        .select('path')
      expect(error).toBeNull()
      expect(data).toEqual([{ path: 'subtotal' }])
      await withDb(async (db) =>
        expect(await field(db, id, 'subtotal')).toMatchObject({
          extracted_value: '120.00',
          corrected_value: '100.00',
          corrected_by: member.id,
          corrected: true,
        }),
      )
    })

    it('refuse an update of the extracted value, or of anything but corrected_value', async () => {
      const { id } = await extractedInvoice(owner, ws)
      for (const values of [{ extracted_value: '1.00' }, { confidence: 1 }, { flags: [] }, { corrected_by: stranger.id }]) {
        const { error } = await member.client.from('extraction_fields').update(values).eq('document_id', id).eq('path', 'total')
        expect(error?.code, JSON.stringify(values)).toBe('42501')
      }
      await withDb(async (db) => expect(await field(db, id, 'total')).toMatchObject({ extracted_value: '119.00', corrected_value: null }))
    })

    it('change nothing for a non-member, for anon, or once the document is approved', async () => {
      const open = await extractedInvoice(owner, ws)
      const approved = await extractedInvoice(owner, ws, { status: 'approved' })
      for (const [client, id] of [
        [stranger.client, open.id],
        [member.client, approved.id],
      ] as const) {
        const { data } = await client.from('extraction_fields').update({ corrected_value: '5.00' }).eq('document_id', id).eq('path', 'total').select()
        expect(data ?? []).toEqual([])
      }
      const { error } = await anonClient().from('extraction_fields').update({ corrected_value: '5.00' }).eq('document_id', open.id)
      expect(error?.code).toBe('42501')
      await withDb(async (db) => {
        for (const id of [open.id, approved.id]) expect((await field(db, id, 'total')).corrected_value).toBeNull()
      })
    })

    it('keep only the last four characters of a corrected card, account or IBAN number (OQ-29)', async () => {
      const { id } = await extractedInvoice(owner, ws)
      await withDb((db) =>
        db.query(
          "insert into public.extraction_fields (document_id, workspace_id, path, kind, extracted_value, confidence) values ($1, $2, 'card_last4', 'text', '1111', 0.9)",
          [id, ws],
        ),
      )
      await member.client.from('extraction_fields').update({ corrected_value: '4111 1111 1111 1234' }).eq('document_id', id).eq('path', 'card_last4')
      await withDb(async (db) => expect((await field(db, id, 'card_last4')).corrected_value).toBe('1234'))
    })
  })

  describe('add_line_item and delete_line_item (OQ-44)', () => {
    it('add an empty line of the type’s cells after a line, moving the later lines down', async () => {
      const { id } = await extractedInvoice(owner, ws)
      expect((await member.client.rpc('add_line_item', { document_id: id, after_position: 0 })).error).toBeNull()
      expect((await member.client.rpc('add_line_item', { document_id: id, after_position: -1 })).error).toBeNull()
      await withDb(async (db) => {
        const cells = await lineCells(db, id)
        const names = DOC_TYPES.invoice.lineFields.map((l) => l.name)
        expect(Object.keys(cells).sort()).toEqual([0, 1, 2].flatMap((i) => names.map((n) => `line_items[${i}].${n}`)).sort())
        // The extracted line is now the second; the first and third are the added ones.
        expect(cells['line_items[1].description']).toBe('Widgets')
        expect(cells['line_items[0].description']).toBeNull()
        expect(cells['line_items[2].amount']).toBeNull()
        const added = await field(db, id, 'line_items[0].amount')
        expect(added).toMatchObject({ extracted_value: null, confidence: null, corrected_by: member.id, flags: [] })
        const kinds = await db.query("select kind from public.extraction_fields where document_id = $1 and path = 'line_items[2].quantity'", [id])
        expect(kinds.rows).toEqual([{ kind: 'number' }])
      })
    })

    it('delete a line, moving the later lines up', async () => {
      const { id } = await extractedInvoice(owner, ws)
      await member.client.rpc('add_line_item', { document_id: id, after_position: -1 })
      await member.client.from('extraction_fields').update({ corrected_value: 'Added' }).eq('document_id', id).eq('path', 'line_items[0].description')
      expect((await member.client.rpc('delete_line_item', { document_id: id, line_position: 1 })).error).toBeNull()
      await withDb(async (db) => {
        const cells = await lineCells(db, id)
        expect(Object.keys(cells).every((p) => p.startsWith('line_items[0].'))).toBe(true)
        expect(cells['line_items[0].description']).toBe('Added')
      })
    })

    it('refuse a line that does not exist, a non-member, anon and a document that does not need review', async () => {
      const open = await extractedInvoice(owner, ws)
      const approved = await extractedInvoice(owner, ws, { status: 'approved' })
      expect((await member.client.rpc('add_line_item', { document_id: open.id, after_position: 1 })).error?.code).toBe('22023')
      expect((await member.client.rpc('delete_line_item', { document_id: open.id, line_position: 1 })).error?.code).toBe('22023')
      for (const client of [stranger.client, anonClient()]) {
        expect((await client.rpc('add_line_item', { document_id: open.id, after_position: 0 })).error?.code).toBe('42501')
        expect((await client.rpc('delete_line_item', { document_id: open.id, line_position: 0 })).error?.code).toBe('42501')
      }
      expect((await member.client.rpc('add_line_item', { document_id: approved.id, after_position: 0 })).error?.code).toBe('22023')
      expect((await member.client.rpc('delete_line_item', { document_id: approved.id, line_position: 0 })).error?.code).toBe('22023')
      await withDb(async (db) => expect(Object.keys(await lineCells(db, open.id))).toHaveLength(DOC_TYPES.invoice.lineFields.length))
    })

    it('add the cells shared/doctypes defines for each type', async () => {
      const sql = await withDb(async (db) => {
        const out: Record<string, [string, string][]> = {}
        for (const t of Object.keys(DOC_TYPES)) {
          const { rows } = await db.query<{ name: string; kind: string }>('select name, kind from public.line_item_fields($1) order by ord', [t])
          out[t] = rows.map((r) => [r.name, r.kind])
        }
        return out
      })
      for (const [t, def] of Object.entries(DOC_TYPES)) expect(sql[t], t).toEqual(def.lineFields.map((l) => [l.name, l.kind]))
    })
  })

  describe('set_check_ticked (OQ-11)', () => {
    it('lets a member tick and untick a check; members read the tick, a non-member does not', async () => {
      const { id } = await extractedInvoice(owner, ws, { subtotal: '120.00' })
      expect((await member.client.rpc('set_check_ticked', { document_id: id, check_id: 'A2', ticked: true })).error).toBeNull()
      const { data } = await owner.client.from('check_ticks').select('check_id, ticked_by, workspace_id').eq('document_id', id)
      expect(data).toEqual([{ check_id: 'A2', ticked_by: member.id, workspace_id: ws }])
      expect((await stranger.client.from('check_ticks').select().eq('document_id', id)).data).toEqual([])

      expect((await member.client.rpc('set_check_ticked', { document_id: id, check_id: 'A2', ticked: false })).error).toBeNull()
      expect((await owner.client.from('check_ticks').select().eq('document_id', id)).data).toEqual([])
    })

    it('refuses a check the document does not have, a non-member, anon and a document that does not need review', async () => {
      const open = await extractedInvoice(owner, ws, { subtotal: '120.00' })
      const approved = await extractedInvoice(owner, ws, { status: 'approved', subtotal: '120.00' })
      expect((await member.client.rpc('set_check_ticked', { document_id: open.id, check_id: 'Z9', ticked: true })).error?.code).toBe('22023')
      for (const client of [stranger.client, anonClient()]) {
        expect((await client.rpc('set_check_ticked', { document_id: open.id, check_id: 'A2', ticked: true })).error?.code).toBe('42501')
      }
      const wrong = await member.client.rpc('set_check_ticked', { document_id: approved.id, check_id: 'A2', ticked: true })
      expect(wrong.error?.code).toBe('22023')
      await withDb(async (db) => {
        const { rows } = await db.query('select 1 from public.check_ticks where document_id = any($1)', [[open.id, approved.id]])
        expect(rows).toEqual([])
      })
    })

    it('cannot be written by a client directly', async () => {
      const { id } = await extractedInvoice(owner, ws, { subtotal: '120.00' })
      const { error } = await member.client.from('check_ticks').insert({ document_id: id, workspace_id: ws, check_id: 'A2' })
      expect(error?.code).toBe('42501')
    })
  })

  describe('reopen_document (OQ-12)', () => {
    it('lets any member reopen an approved document: needs review again, the approval cleared, the reopen logged', async () => {
      const { id } = await extractedInvoice(owner, ws, { status: 'approved' })
      await withDb((db) => db.query('update public.documents set approved_by = $2, approved_at = now() where id = $1', [id, owner.id]))
      expect((await member.client.rpc('reopen_document', { document_id: id })).error).toBeNull()
      await withDb(async (db) => {
        expect(await documentRow(db, id)).toMatchObject({ status: 'needs_review', approved_by: null, approved_at: null })
        const { rows } = await db.query("select actor from public.document_events where document_id = $1 and kind = 'reopened'", [id])
        expect(rows).toEqual([{ actor: member.id }])
      })
    })

    it('refuses a non-member, anon and a document that is not approved', async () => {
      const approved = await extractedInvoice(owner, ws, { status: 'approved' })
      const open = await extractedInvoice(owner, ws)
      for (const client of [stranger.client, anonClient()]) {
        expect((await client.rpc('reopen_document', { document_id: approved.id })).error?.code).toBe('42501')
      }
      expect((await member.client.rpc('reopen_document', { document_id: open.id })).error?.code).toBe('22023')
      await withDb(async (db) => expect((await documentRow(db, approved.id)).status).toBe('approved'))
    })
  })

  describe('change_document_type (OQ-1, Lead ruling 1 on #32)', () => {
    it('discards the results of a document that needs review, clears its duplicate link and queues it as the chosen type', async () => {
      const earlier = await extractedInvoice(owner, ws, { invoiceNumber: 'INV-TYPE-1' })
      const { id } = await extractedInvoice(owner, ws, { invoiceNumber: 'INV-TYPE-1', subtotal: '120.00' })
      await member.client.rpc('set_check_ticked', { document_id: id, check_id: 'A2', ticked: true })
      await withDb(async (db) => expect((await documentRow(db, id)).duplicate_of).toBe(earlier.id))

      await rolledBack(async (db) => {
        const before = await usage(db, ws, owner.id)
        await asUser(db, member.id)
        await db.query('select public.change_document_type($1, $2)', [id, 'receipt'])
        await db.query('reset role')
        expect(await documentRow(db, id)).toMatchObject({
          status: 'queued',
          doc_type: 'receipt',
          doc_type_source: 'user',
          duplicate_key: null,
          duplicate_of: null,
          attempts: 0,
          pages_reserved: true,
        })
        for (const table of ['extraction_fields', 'check_results', 'check_ticks']) {
          expect((await db.query(`select 1 from public.${table} where document_id = $1`, [id])).rows, table).toEqual([])
        }
        const events = await db.query("select actor from public.document_events where document_id = $1 and kind = 'type_changed'", [id])
        expect(events.rows).toEqual([{ actor: member.id }])
        const messages = await db.query("select message from pgmq.q_extract where message ->> 'document_id' = $1", [id])
        expect(messages.rows).toEqual([{ message: { document_id: id } }])
        // A document that needs review has its pages counted already (PRD US-1.2 AC-5).
        expect(await usage(db, ws, owner.id)).toEqual(before)
      })
    })

    it('reserves the pages of a not supported document again', async () => {
      const { id } = await createDocument(owner, ws)
      await withDb(async (db) => {
        await db.query("update public.documents set status = 'unsupported', page_count = 2 where id = $1", [id])
      })
      await rolledBack(async (db) => {
        await freeAllowance(db, ws, owner.id)
        const before = await usage(db, ws, owner.id)
        await asUser(db, member.id)
        await db.query('select public.change_document_type($1, $2)', [id, 'quote'])
        await db.query('reset role')
        expect(await documentRow(db, id)).toMatchObject({ status: 'queued', doc_type: 'quote', pages_reserved: true })
        expect(await usage(db, ws, owner.id)).toEqual({ workspace: before.workspace + 2, account: before.account + 2 })
      })
    })

    it('refuses a deleted file, a type that is not one of the six, a non-member, anon and the wrong status', async () => {
      const open = await extractedInvoice(owner, ws)
      const approved = await extractedInvoice(owner, ws, { status: 'approved' })
      const deleted = await extractedInvoice(owner, ws)
      await withDb((db) => db.query('update public.documents set file_deleted_at = now() where id = $1', [deleted.id]))
      await rolledBack(async (db) => {
        const call = 'select public.change_document_type($1, $2)'
        expect(await codeOf(db, member.id, call, [deleted.id, 'receipt'])).toBe('22023')
        expect(await codeOf(db, member.id, call, [open.id, 'payslip'])).toBe('22023')
        expect(await codeOf(db, member.id, call, [approved.id, 'receipt'])).toBe('22023')
        expect(await codeOf(db, stranger.id, call, [open.id, 'receipt'])).toBe('42501')
      })
      expect((await anonClient().rpc('change_document_type', { document_id: open.id, doc_type: 'receipt' })).error?.code).toBe('42501')
      await withDb(async (db) => {
        for (const id of [open.id, deleted.id]) expect(await documentRow(db, id)).toMatchObject({ status: 'needs_review', doc_type: 'invoice' })
      })
    })
  })

  describe('get_amount_tolerance', () => {
    it('gives a signed-in user app_config’s tolerance, and anon nothing', async () => {
      expect(await member.client.rpc('get_amount_tolerance')).toMatchObject({ data: 0.01, error: null })
      expect((await anonClient().rpc('get_amount_tolerance')).error?.code).toBe('42501')
    })
  })

  describe('the history', () => {
    it('has an extracted event for each extraction that reaches needs review', async () => {
      const { id } = await extractedInvoice(owner, ws)
      const { data } = await member.client.from('document_events').select('kind, actor').eq('document_id', id)
      expect(data).toEqual([{ kind: 'extracted', actor: null }])
      expect((await stranger.client.from('document_events').select().eq('document_id', id)).data).toEqual([])
    })
  })
})

describe('approve-document (OQ-11, Lead ruling 2 on #32)', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
    // A cold edge runtime loads the function's modules on its first request.
    await anonClient().functions.invoke('approve-document', { body: {} })
  }, 60_000)

  async function approve(user: TestUser, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { data, error } = await user.client.functions.invoke('approve-document', { body: { document_id: id } })
    if (error instanceof FunctionsHttpError) return { status: error.context.status, body: await error.context.json() }
    if (error) throw error
    return { status: 200, body: data }
  }

  async function checks(db: Db, id: string) {
    const { rows } = await db.query<{ check_id: string; status: string }>(
      'select check_id, status from public.check_results where document_id = $1 order by check_id',
      [id],
    )
    return Object.fromEntries(rows.map((r) => [r.check_id, r.status]))
  }

  it('refuses with 409 while failed checks have no tick, naming them, and approves nothing', async () => {
    const { id } = await extractedInvoice(owner, ws, { subtotal: '120.00' })
    const result = await approve(member, id)
    expect(result).toEqual({ status: 409, body: { error: 'Tick the failed checks A2 and A3 before approving.', unticked: ['A2', 'A3'] } })
    await withDb(async (db) => {
      expect(await documentRow(db, id)).toMatchObject({ status: 'needs_review', approved_by: null })
      expect((await db.query("select 1 from public.document_events where document_id = $1 and kind = 'approved'", [id])).rows).toEqual([])
    })
  })

  it('refuses a non-member with 404, and anon, and approves nothing', async () => {
    const { id } = await extractedInvoice(owner, ws)
    expect((await approve(stranger, id)).status).toBe(404)
    const { error } = await anonClient().functions.invoke('approve-document', { body: { document_id: id } })
    expect(error).toBeInstanceOf(FunctionsHttpError)
    expect((error as FunctionsHttpError).context.status).toBe(401)
    await withDb(async (db) => expect((await documentRow(db, id)).status).toBe('needs_review'))
  })

  it('approves once every failed check is ticked: status, approver, time and an approved event', async () => {
    const { id } = await extractedInvoice(owner, ws, { subtotal: '120.00' })
    for (const check_id of ['A2', 'A3']) await member.client.rpc('set_check_ticked', { document_id: id, check_id, ticked: true })
    const result = await approve(member, id)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ document: { id, status: 'approved', approved_by: member.id } })
    await withDb(async (db) => {
      const row = await documentRow(db, id)
      expect(row).toMatchObject({ status: 'approved', approved_by: member.id })
      expect(row.approved_at).not.toBeNull()
      const { rows } = await db.query("select actor from public.document_events where document_id = $1 and kind = 'approved'", [id])
      expect(rows).toEqual([{ actor: member.id }])
    })
    // A second approval is refused: it no longer needs review.
    expect((await approve(member, id)).status).toBe(409)
  })

  it('re-runs the checks on the corrected values and stores them: a corrected subtotal approves with no tick', async () => {
    const { id } = await extractedInvoice(owner, ws, { subtotal: '120.00' })
    await member.client.from('extraction_fields').update({ corrected_value: '100.00' }).eq('document_id', id).eq('path', 'subtotal')
    expect((await approve(member, id)).status).toBe(200)
    await withDb(async (db) => {
      expect(await checks(db, id)).toMatchObject({ A2: 'pass', A3: 'pass' })
      expect((await field(db, id, 'subtotal')).flags).toEqual([])
    })
  })

  it('stores a check a correction broke, and refuses until it is ticked', async () => {
    const { id } = await extractedInvoice(owner, ws)
    await member.client.from('extraction_fields').update({ corrected_value: '130.00' }).eq('document_id', id).eq('path', 'total')
    expect(await approve(member, id)).toMatchObject({ status: 409, body: { unticked: ['A3'] } })
    await withDb(async (db) => {
      expect((await checks(db, id)).A3).toBe('fail')
      expect((await field(db, id, 'total')).flags).toEqual(['check_failed'])
    })
    await member.client.rpc('set_check_ticked', { document_id: id, check_id: 'A3', ticked: true })
    expect((await approve(member, id)).status).toBe(200)
  })

  it('runs U1 against the database with the corrected key: a new duplicate is stored, named, and needs a tick', async () => {
    const earlier = await extractedInvoice(owner, ws, { invoiceNumber: 'INV-U1-A', file_name: 'Earlier invoice.pdf' })
    const { id } = await extractedInvoice(owner, ws, { invoiceNumber: 'INV-U1-B' })
    await member.client.from('extraction_fields').update({ corrected_value: 'INV-U1-A' }).eq('document_id', id).eq('path', 'invoice_number')

    const refused = await approve(member, id)
    expect(refused).toEqual({ status: 409, body: { error: 'Tick the failed check U1 before approving.', unticked: ['U1'] } })
    await withDb(async (db) => {
      expect(await documentRow(db, id)).toMatchObject({ duplicate_of: earlier.id, duplicate_key: 'invoice|acmegmbh|invu1a' })
      const { rows } = await db.query("select message, field_paths from public.check_results where document_id = $1 and check_id = 'U1'", [id])
      expect(rows).toEqual([
        { message: 'Duplicate of "Earlier invoice.pdf": the same vendor and invoice number.', field_paths: ['vendor_name', 'invoice_number'] },
      ])
      expect((await field(db, id, 'invoice_number')).flags).toEqual(['duplicate'])
    })

    await member.client.rpc('set_check_ticked', { document_id: id, check_id: 'U1', ticked: true })
    expect((await approve(member, id)).status).toBe(200)
  })

  it('clears a duplicate a correction resolved', async () => {
    await extractedInvoice(owner, ws, { invoiceNumber: 'INV-U1-C' })
    const { id } = await extractedInvoice(owner, ws, { invoiceNumber: 'INV-U1-C' })
    await withDb(async (db) => expect((await checks(db, id)).U1).toBe('fail'))
    await member.client.from('extraction_fields').update({ corrected_value: 'INV-U1-D' }).eq('document_id', id).eq('path', 'invoice_number')
    expect((await approve(member, id)).status).toBe(200)
    await withDb(async (db) => {
      expect(await documentRow(db, id)).toMatchObject({ duplicate_of: null, duplicate_key: 'invoice|acmegmbh|invu1d' })
      expect((await checks(db, id)).U1).toBe('pass')
    })
  })

  it('is executable only by the service role as approve_document', async () => {
    const { id } = await extractedInvoice(owner, ws)
    for (const client of [member.client, anonClient()]) {
      const { error } = await client.rpc('approve_document', { document_id: id, actor: member.id, result: {} })
      expect(error?.code).toBe('42501')
    }
  })
})

describe('single-document delete (F19, OQ-20)', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
  })

  const exists = (db: Db, sql: string, id: string) => db.query(sql, [id]).then((r) => r.rowCount ?? 0)

  async function leftovers(db: Db, id: string, path: string) {
    return {
      document: await exists(db, 'select 1 from public.documents where id = $1', id),
      fields: await exists(db, 'select 1 from public.extraction_fields where document_id = $1', id),
      checks: await exists(db, 'select 1 from public.check_results where document_id = $1', id),
      ticks: await exists(db, 'select 1 from public.check_ticks where document_id = $1', id),
      events: await exists(db, 'select 1 from public.document_events where document_id = $1', id),
      extractions: await exists(db, 'select 1 from public.extractions where document_id = $1', id),
      file: await exists(db, "select 1 from storage.objects where bucket_id = 'documents' and name = $1", path),
    }
  }

  it('lets any member delete a document with its file and every result, and refunds no pages (US-19.1 AC-3, AC-4)', async () => {
    const doc = await extractedInvoice(owner, ws, { subtotal: '120.00', withFile: true, invoiceNumber: 'INV-DEL-1' })
    const later = await extractedInvoice(owner, ws, { invoiceNumber: 'INV-DEL-1' })
    await member.client.rpc('set_check_ticked', { document_id: doc.id, check_id: 'A2', ticked: true })
    const before = await withDb(async (db) => {
      expect(await leftovers(db, doc.id, doc.storage_path)).toEqual({
        document: 1,
        fields: expect.any(Number),
        checks: 7,
        ticks: 1,
        events: 1,
        extractions: 1,
        file: 1,
      })
      expect((await documentRow(db, later.id)).duplicate_of).toBe(doc.id)
      return usage(db, ws, owner.id)
    })

    expect(await deleteDocument(doc.id, { asCaller: member.client, admin: adminClient })).toEqual({ status: 204 })
    await withDb(async (db) => {
      expect(await leftovers(db, doc.id, doc.storage_path)).toEqual({
        document: 0,
        fields: 0,
        checks: 0,
        ticks: 0,
        events: 0,
        extractions: 0,
        file: 0,
      })
      expect(await usage(db, ws, owner.id)).toEqual(before)
      expect((await documentRow(db, later.id)).duplicate_of).toBeNull()
    })
  })

  it('releases the pages a queued, waiting or processing document holds (US-19.1 AC-5)', async () => {
    for (const status of ['queued', 'waiting_budget', 'processing']) {
      const { id } = await createDocument(owner, ws)
      const before = await withDb(async (db) => {
        await db.query('update public.documents set page_count = 2 where id = $1', [id])
        await db.query('begin')
        await freeAllowance(db, ws, owner.id)
        await asServiceRole(db)
        const reserved = await db.query<{ ok: boolean }>('select public.reserve_pages($1) as ok', [id])
        expect(reserved.rows[0].ok).toBe(true)
        await db.query('reset role')
        await db.query('update public.documents set status = $2 where id = $1', [id, status])
        await db.query('commit')
        return usage(db, ws, owner.id)
      })
      expect(await deleteDocument(id, { asCaller: owner.client, admin: adminClient })).toEqual({ status: 204 })
      await withDb(async (db) => {
        expect(await usage(db, ws, owner.id), status).toEqual({ workspace: before.workspace - 2, account: before.account - 2 })
        expect(await exists(db, 'select 1 from public.documents where id = $1', id)).toBe(0)
      })
    }
  })

  it('deletes a document whose file was already deleted', async () => {
    const doc = await extractedInvoice(owner, ws)
    await withDb((db) => db.query('update public.documents set file_deleted_at = now() where id = $1', [doc.id]))
    expect(await deleteDocument(doc.id, { asCaller: member.client, admin: adminClient })).toEqual({ status: 204 })
    await withDb(async (db) => expect(await exists(db, 'select 1 from public.documents where id = $1', doc.id)).toBe(0))
  })

  it('refuses a non-member with 404 and a caller who is not signed in with 401, and changes nothing (AC-6)', async () => {
    const doc = await extractedInvoice(owner, ws, { withFile: true })
    expect(await deleteDocument(doc.id, { asCaller: stranger.client, admin: adminClient })).toEqual({
      status: 404,
      error: 'This document does not exist.',
    })
    expect(await deleteDocument(doc.id, { asCaller: anonClient(), admin: adminClient })).toMatchObject({ status: 401 })
    expect(await deleteDocument('not-a-uuid', { asCaller: member.client, admin: adminClient })).toMatchObject({ status: 404 })
    await withDb(async (db) => expect(await leftovers(db, doc.id, doc.storage_path)).toMatchObject({ document: 1, file: 1, events: 1 }))
  })

  it('keeps delete_document from anon and authenticated', async () => {
    const doc = await extractedInvoice(owner, ws)
    for (const client of [member.client, anonClient()]) {
      expect((await client.rpc('delete_document', { document_id: doc.id })).error?.code).toBe('42501')
    }
    await withDb(async (db) => expect(await exists(db, 'select 1 from public.documents where id = $1', doc.id)).toBe(1))
  })
})
