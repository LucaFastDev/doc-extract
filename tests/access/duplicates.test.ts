import { readFileSync } from 'node:fs'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { utcDate } from '../../shared/doctypes/checks'
import { checkU1 } from '../../shared/doctypes/duplicate'
import { DOC_TYPES, prepareResult, type DocType } from '../../shared/doctypes/index'
import { asServiceRole, withDb } from './local-db'
import { anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// Duplicate detection in record_extraction (PRD section 4.3, OQ-9, ARCHITECTURE.md sections 4.1
// and 6.3, Lead rulings 1 to 4 on #27 and the rulings on the worker's questions): the same file
// or the same normalised U1 key in the same workspace, the earliest earlier document as
// duplicate_of, later documents flagged when an earlier one records after them, and the statuses
// that count. Results are built by prepareResult from the recorded tool calls, as process-queue
// builds them.

type Db = pg.Client

function toolInput(fixture: string): Record<string, unknown> {
  const url = new URL(`../../supabase/functions/_shared/fixtures/${fixture}.json`, import.meta.url)
  const body = JSON.parse(readFileSync(url, 'utf8')).body as { content: { type: string; input: Record<string, unknown> }[] }
  return structuredClone(body.content.find((b) => b.type === 'tool_use')!.input)
}

/** The record process-queue sends for this tool input. */
function resultFor(docType: DocType, input: Record<string, unknown>) {
  const prepared = prepareResult(docType, input, { confidenceThreshold: 0.8, amountTolerance: '0.01', today: utcDate(new Date()) })
  if (!prepared.ok) throw new Error(prepared.errors.join('; '))
  return {
    model: 'claude-sonnet-5-5',
    prompt_version: 'test',
    input_tokens: 1000,
    output_tokens: 200,
    cost_usd: 0,
    outcome: 'ok',
    status: 'needs_review',
    tool_name: DOC_TYPES[docType].tool.name,
    doc_type: docType,
    raw_output: input,
    fields: prepared.fields,
    checks: prepared.checks,
    duplicate: { key: prepared.duplicate.key, label: prepared.duplicate.label },
  }
}

const invoice = (fixture = 'invoice') => resultFor('invoice', toolInput(fixture))

/** A document as submit-document and process-queue leave it before the result: processing, with its hash. */
async function processingDocument(user: TestUser, ws: string, o: { name: string; sha: string; minutesAgo: number }): Promise<string> {
  const { id } = await createDocument(user, ws, { file_name: o.name, mime_type: 'application/pdf', byte_size: 1024 })
  await withDb((db) =>
    db.query(
      `update public.documents set status = 'processing', page_count = 1, sha256 = $2,
         created_at = now() - make_interval(mins => $3), processing_started_at = now()
       where id = $1`,
      [id, o.sha, o.minutesAgo],
    ),
  )
  return id
}

async function record(id: string, result: Record<string, unknown>): Promise<string> {
  return withDb(async (db) => {
    await db.query('begin')
    await asServiceRole(db)
    const { rows } = await db.query('select public.record_extraction($1, null, $2) as r', [id, result])
    await db.query('commit')
    return rows[0].r as string
  })
}

interface Stored {
  status: string
  duplicate_of: string | null
  duplicate_key: string | null
  u1: { check_id: string; status: string; field_paths: string[]; message: string | null }
  flagged: string[]
}

async function stored(db: Db, id: string): Promise<Stored> {
  const d = await db.query('select status, duplicate_of, duplicate_key from public.documents where id = $1', [id])
  const u1 = await db.query("select check_id, status, field_paths, message from public.check_results where document_id = $1 and check_id = 'U1'", [id])
  const f = await db.query(
    "select path from public.extraction_fields where document_id = $1 and 'duplicate' = any(flags) order by path",
    [id],
  )
  return { ...d.rows[0], u1: u1.rows[0], flagged: f.rows.map((r) => r.path) }
}

const read = (id: string) => withDb((db) => stored(db, id))

/** A fresh workspace per test, so no test sees another's documents. */
async function workspace() {
  const user = await signUp()
  return { user, ws: await personalWorkspaceId(user) }
}

describe('duplicate detection in record_extraction', () => {
  it('flags the same file uploaded twice in a workspace, pointing to the earlier one', async () => {
    const { user, ws } = await workspace()
    const first = await processingDocument(user, ws, { name: 'first.pdf', sha: 'same-file', minutesAgo: 10 })
    const second = await processingDocument(user, ws, { name: 'second.pdf', sha: 'same-file', minutesAgo: 5 })
    // Different keys: only the file matches.
    const other = toolInput('invoice')
    ;(other.invoice_number as { value: string }).value = 'INV-9999'
    expect(await record(first, invoice())).toBe('recorded')
    expect(await record(second, resultFor('invoice', other))).toBe('recorded')

    const a = await read(first)
    expect(a).toMatchObject({ status: 'needs_review', duplicate_of: null, u1: { status: 'pass', message: null }, flagged: [] })
    const b = await read(second)
    expect(b).toMatchObject({
      status: 'needs_review',
      duplicate_of: first,
      u1: { status: 'fail', field_paths: ['vendor_tax_id', 'invoice_number'], message: 'Duplicate of "first.pdf": the same file was uploaded before.' },
      flagged: ['invoice_number', 'vendor_tax_id'],
    })
    // The message is checkU1's, word for word.
    const key = DOC_TYPES.invoice.duplicateKey({ fields: { vendor_tax_id: 'DE123456789', invoice_number: 'INV-9999' }, line_items: [] })
    expect(b.u1).toEqual(checkU1(key, { file_name: 'first.pdf', by: 'file' }))
  })

  it('flags a different file with the same key, and stores the normalised key', async () => {
    const { user, ws } = await workspace()
    const first = await processingDocument(user, ws, { name: 'INV-1042.pdf', sha: 'file-a', minutesAgo: 10 })
    const second = await processingDocument(user, ws, { name: 'INV-1042 again.pdf', sha: 'file-b', minutesAgo: 5 })
    await record(first, invoice())
    await record(second, invoice())

    const a = await read(first)
    expect(a.duplicate_key).toBe('invoice|de123456789|inv1042')
    const b = await read(second)
    expect(b).toMatchObject({ duplicate_of: first, duplicate_key: 'invoice|de123456789|inv1042', flagged: ['invoice_number', 'vendor_tax_id'] })
    expect(b.u1).toEqual(checkU1(DOC_TYPES.invoice.duplicateKey({ fields: { vendor_tax_id: 'x', invoice_number: 'y' }, line_items: [] }), {
      file_name: 'INV-1042.pdf',
      by: 'key',
    }))
    expect(b.u1.message).toBe('Duplicate of "INV-1042.pdf": the same vendor and invoice number.')
  })

  it('matches a key printed with different case, spacing and punctuation', async () => {
    const { user, ws } = await workspace()
    const first = await processingDocument(user, ws, { name: 'original.pdf', sha: 'file-a', minutesAgo: 10 })
    const second = await processingDocument(user, ws, { name: 'rescan.pdf', sha: 'file-b', minutesAgo: 5 })
    // "DE123456789" / "INV-1042" against "DE 123 456 789" / "inv 1042".
    await record(first, invoice('invoice'))
    await record(second, invoice('invoice-duplicate'))
    expect(await read(second)).toMatchObject({ duplicate_of: first, u1: { status: 'fail' } })
  })

  it('does not match the same key, or the same file, in another workspace', async () => {
    const one = await workspace()
    const two = await workspace()
    const first = await processingDocument(one.user, one.ws, { name: 'a.pdf', sha: 'shared-file', minutesAgo: 10 })
    const second = await processingDocument(two.user, two.ws, { name: 'b.pdf', sha: 'shared-file', minutesAgo: 5 })
    await record(first, invoice())
    await record(second, invoice())
    expect(await read(second)).toMatchObject({ duplicate_of: null, u1: { status: 'pass' }, flagged: [] })
  })

  it('still counts an earlier document whose file was deleted', async () => {
    const { user, ws } = await workspace()
    const first = await processingDocument(user, ws, { name: 'old.pdf', sha: 'file-a', minutesAgo: 60 * 24 * 8 })
    await record(first, invoice())
    await withDb((db) => db.query('update public.documents set file_deleted_at = now() where id = $1', [first]))
    const second = await processingDocument(user, ws, { name: 'new.pdf', sha: 'file-b', minutesAgo: 1 })
    await record(second, invoice())
    expect(await read(second)).toMatchObject({ duplicate_of: first, u1: { status: 'fail', message: 'Duplicate of "old.pdf": the same vendor and invoice number.' } })
  })

  it('points to the earliest of several earlier matches', async () => {
    const { user, ws } = await workspace()
    const oldest = await processingDocument(user, ws, { name: 'oldest.pdf', sha: 'f1', minutesAgo: 30 })
    const middle = await processingDocument(user, ws, { name: 'middle.pdf', sha: 'f2', minutesAgo: 20 })
    const newest = await processingDocument(user, ws, { name: 'newest.pdf', sha: 'f3', minutesAgo: 10 })
    for (const id of [oldest, middle, newest]) await record(id, invoice())
    expect((await read(middle)).duplicate_of).toBe(oldest)
    expect((await read(newest)).duplicate_of).toBe(oldest)
    expect(await read(oldest)).toMatchObject({ duplicate_of: null, u1: { status: 'pass' } })
  })

  it('flags a later document that recorded first when the earlier one records, and leaves the earlier one unflagged', async () => {
    const { user, ws } = await workspace()
    const earlier = await processingDocument(user, ws, { name: 'earlier.pdf', sha: 'file-a', minutesAgo: 10 })
    const later = await processingDocument(user, ws, { name: 'later.pdf', sha: 'file-b', minutesAgo: 5 })
    await record(later, invoice())
    // The earlier one had no key yet when the later one recorded.
    expect(await read(later)).toMatchObject({ duplicate_of: null, u1: { status: 'pass' } })

    await record(earlier, invoice())
    expect(await read(earlier)).toMatchObject({ duplicate_of: null, u1: { status: 'pass' }, flagged: [] })
    expect(await read(later)).toMatchObject({
      status: 'needs_review',
      duplicate_of: earlier,
      u1: { status: 'fail', field_paths: ['vendor_tax_id', 'invoice_number'], message: 'Duplicate of "earlier.pdf": the same vendor and invoice number.' },
      flagged: ['invoice_number', 'vendor_tax_id'],
    })
  })

  it('repoints a later document from a later match to the earliest, and leaves an approved one as it is', async () => {
    const { user, ws } = await workspace()
    const a = await processingDocument(user, ws, { name: 'a.pdf', sha: 'f1', minutesAgo: 30 })
    const b = await processingDocument(user, ws, { name: 'b.pdf', sha: 'f2', minutesAgo: 20 })
    const c = await processingDocument(user, ws, { name: 'c.pdf', sha: 'f3', minutesAgo: 10 })
    const d = await processingDocument(user, ws, { name: 'd.pdf', sha: 'f4', minutesAgo: 5 })
    await record(b, invoice())
    await record(c, invoice())
    await record(d, invoice())
    expect((await read(c)).duplicate_of).toBe(b)
    await withDb((db) => db.query("update public.documents set status = 'approved' where id = $1", [d]))

    await record(a, invoice())
    expect((await read(b)).duplicate_of).toBe(a)
    const cNow = await read(c)
    expect(cNow).toMatchObject({ duplicate_of: a, u1: { message: 'Duplicate of "a.pdf": the same vendor and invoice number.' } })
    // The flag is not added twice.
    expect(cNow.flagged).toEqual(['invoice_number', 'vendor_tax_id'])
    const flags = await withDb((db) =>
      db.query("select flags from public.extraction_fields where document_id = $1 and path = 'invoice_number'", [c]),
    )
    expect(flags.rows[0].flags.filter((f: string) => f === 'duplicate')).toHaveLength(1)
    // Approved: untouched, still pointing where it did.
    expect(await read(d)).toMatchObject({ status: 'approved', duplicate_of: b, u1: { message: 'Duplicate of "b.pdf": the same vendor and invoice number.' } })
  })

  it('does not count rejected, failed or unsupported documents, and counts a queued one by its file', async () => {
    const { user, ws } = await workspace()
    const ids: Record<string, string> = {}
    for (const [i, status] of ['rejected', 'failed', 'unsupported', 'queued'].entries()) {
      ids[status] = await processingDocument(user, ws, { name: `${status}.pdf`, sha: 'one-file', minutesAgo: 40 - i })
      await withDb((db) => db.query('update public.documents set status = $2 where id = $1', [ids[status], status]))
    }
    const latest = await processingDocument(user, ws, { name: 'latest.pdf', sha: 'one-file', minutesAgo: 1 })
    await record(latest, invoice())
    expect(await read(latest)).toMatchObject({
      duplicate_of: ids.queued,
      u1: { status: 'fail', message: 'Duplicate of "queued.pdf": the same file was uploaded before.' },
    })
  })

  it('fails U1 with no fields when only the file matched and no key field has a value', async () => {
    const { user, ws } = await workspace()
    const blank = toolInput('invoice')
    for (const name of ['vendor_name', 'vendor_tax_id', 'invoice_number']) (blank[name] as { value: string }).value = ''
    const first = await processingDocument(user, ws, { name: 'scan.pdf', sha: 'same-scan', minutesAgo: 10 })
    const second = await processingDocument(user, ws, { name: 'scan copy.pdf', sha: 'same-scan', minutesAgo: 5 })
    await record(first, resultFor('invoice', blank))
    // With an empty key and no earlier file, U1 is skipped (OQ-43).
    expect((await read(first)).u1).toMatchObject({ status: 'skipped' })
    expect((await read(first)).duplicate_key).toBeNull()

    await record(second, resultFor('invoice', blank))
    expect(await read(second)).toMatchObject({
      duplicate_of: first,
      u1: { status: 'fail', field_paths: [], message: 'Duplicate of "scan.pdf": the same file was uploaded before.' },
      flagged: [],
    })
  })

  it('compares keys only within a type', async () => {
    const { user, ws } = await workspace()
    const quote = await processingDocument(user, ws, { name: 'quote.pdf', sha: 'f1', minutesAgo: 10 })
    const order = await processingDocument(user, ws, { name: 'order.pdf', sha: 'f2', minutesAgo: 5 })
    await record(quote, resultFor('quote', toolInput('quote')))
    await record(order, resultFor('purchase_order', toolInput('purchase-order')))
    expect((await read(quote)).duplicate_key).toBe('quote|imaginarybuildersag|q2026118')
    expect(await read(order)).toMatchObject({ duplicate_key: 'purchase_order|examplestudioltd|po7731', duplicate_of: null })
  })

  it('makes two documents of a workspace that record at the same moment see each other', async () => {
    const { user, ws } = await workspace()
    const earlier = await processingDocument(user, ws, { name: 'earlier.pdf', sha: 'f1', minutesAgo: 10 })
    const later = await processingDocument(user, ws, { name: 'later.pdf', sha: 'f2', minutesAgo: 5 })
    await withDb(async (one) => {
      await withDb(async (two) => {
        const pid = (await two.query('select pg_backend_pid() as pid')).rows[0].pid
        await one.query('begin')
        await asServiceRole(one)
        await one.query('select public.record_extraction($1, null, $2)', [earlier, invoice()])
        // The later document records while the earlier one's transaction is still open.
        await two.query('begin')
        await asServiceRole(two)
        const pending = two.query('select public.record_extraction($1, null, $2)', [later, invoice()])
        // It waits for the workspace's lock rather than reading past the open transaction. Asked
        // from a third connection: inside a transaction, pg_stat_activity is a snapshot.
        const waiting = () =>
          withDb(async (db) => (await db.query('select wait_event from pg_stat_activity where pid = $1', [pid])).rows[0]?.wait_event)
        await expect.poll(waiting).toBe('advisory')
        await one.query('commit')
        await pending
        await two.query('commit')
      })
    })
    expect(await read(later)).toMatchObject({ duplicate_of: earlier, u1: { status: 'fail' } })
  })

  it('keeps record_extraction from anon and members', async () => {
    const { user, ws } = await workspace()
    const id = await processingDocument(user, ws, { name: 'x.pdf', sha: 'x', minutesAgo: 1 })
    for (const client of [user.client, anonClient()]) {
      const { error } = await client.rpc('record_extraction', { document_id: id, reservation: null, result: invoice() })
      expect(error?.code).toBe('42501')
    }
    expect((await read(id)).status).toBe('processing')
  })
})

describe('documents.duplicate_key', () => {
  it('is indexed with the workspace', async () => {
    const { rows } = await withDb((db) =>
      db.query("select indexdef from pg_indexes where schemaname = 'public' and indexname = 'documents_workspace_id_duplicate_key_idx'"),
    )
    expect(rows[0]?.indexdef).toContain('(workspace_id, duplicate_key)')
  })

  it('cannot be written by a member', async () => {
    const { user, ws } = await workspace()
    const id = await processingDocument(user, ws, { name: 'x.pdf', sha: 'x', minutesAgo: 1 })
    await user.client.from('documents').update({ duplicate_key: 'invoice|x|y' }).eq('id', id)
    expect((await read(id)).duplicate_key).toBeNull()
  })
})
