import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { utcDate } from '../../shared/doctypes/checks'
import { prepareResult } from '../../shared/doctypes/index'
import { INVOICE_FIELDS } from '../../shared/doctypes/invoice'
import { deleteAccount } from '../../src/lib/account/delete'
import { deleteDocument } from '../../src/lib/documents/delete'
import { loadReview } from '../../src/lib/documents/load-review'
import { deleteWorkspace, type CancelStripe } from '../../src/lib/workspace/delete'
import { asServiceRole, asUser, rolledBack, withDb } from './local-db'
import { addMember, adminClient, anonClient, apiUrl, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// DELETE /api/workspaces/[id] and DELETE /api/account (ARCHITECTURE.md section 6.2, PRD F18, OQ-17,
// OQ-20, OQ-30, issue #61 criteria 1 to 6, rulings 1 to 7), with real users, RLS, Storage and a
// fake Stripe client that records what it is asked for. Nothing reaches Stripe.

const PDF = new TextEncoder().encode('%PDF-1.7\n%deletion test\n')
const f = (value: string, confidence = 0.95) => ({ value, confidence })
const MONTH = "date_trunc('month', now() at time zone 'utc')::date"

type Db = pg.Client

function fakeStripe(cancel: (id: string) => Promise<unknown> = async () => ({ status: 'canceled' })) {
  const fn = vi.fn(cancel)
  return { stripe: () => ({ subscriptions: { cancel: fn } }) as unknown as CancelStripe, cancel: fn }
}

const noStripe = () => {
  throw new Error('this path must not reach Stripe')
}

/** The service-role client, with one Storage call of the documents bucket answering with an error. */
function failingStorage(which: 'list' | 'remove', after = 0): () => SupabaseClient {
  let calls = 0
  return () => {
    const real = adminClient()
    return new Proxy(real, {
      get(target, prop) {
        if (prop !== 'storage') return Reflect.get(target, prop)
        return {
          from(bucket: string) {
            const api = target.storage.from(bucket)
            return new Proxy(api, {
              get(inner, method) {
                const value = Reflect.get(inner, method) as (...args: unknown[]) => unknown
                if (method !== which) return value.bind(inner)
                return async (...args: unknown[]) => {
                  calls += 1
                  if (calls > after) return { data: null, error: { message: `${which} failed` } }
                  return value.apply(inner, args)
                }
              },
            })
          },
        }
      },
    })
  }
}

/** The service-role client, answering with an error to one RPC, or to deleting from one table. */
function failingAdmin(what: { rpc?: string; deleteFrom?: string; deleteUser?: boolean }): () => SupabaseClient {
  return () => {
    const real = adminClient()
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc' && what.rpc) {
          return (fn: string, args: Record<string, unknown>) =>
            fn === what.rpc ? Promise.resolve({ data: null, error: { message: `${fn} failed` } }) : target.rpc(fn, args)
        }
        if (prop === 'from' && what.deleteFrom) {
          return (table: string) => {
            const builder = target.from(table)
            if (table !== what.deleteFrom) return builder
            return new Proxy(builder, {
              get(inner, method) {
                if (method !== 'delete') return Reflect.get(inner, method)
                return () => ({ eq: async () => ({ data: null, error: { message: 'delete failed' } }) })
              },
            })
          }
        }
        if (prop === 'auth' && what.deleteUser) {
          return { ...target.auth, admin: { deleteUser: async () => ({ data: null, error: { message: 'deleteUser failed' } }) } }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
}

/** Every public table with a workspace_id or document_id column, as the database says today. */
async function keyedTables(db: Db): Promise<{ table: string; column: string }[]> {
  const { rows } = await db.query(
    `select table_name as table, column_name as column from information_schema.columns
     where table_schema = 'public' and column_name in ('workspace_id', 'document_id')
     order by 1, 2`,
  )
  return rows
}

/** The rows of every such table naming the given workspace or documents. */
async function rowsLeft(ws: string, documentIds: string[]) {
  return withDb(async (db) => {
    const left: Record<string, number> = {}
    for (const { table, column } of await keyedTables(db)) {
      const ids = column === 'workspace_id' ? [ws] : documentIds
      const { rows } = await db.query(`select count(*)::int as n from public.${table} where ${column} = any($1::uuid[])`, [ids])
      if (rows[0].n > 0) left[`${table}.${column}`] = rows[0].n
    }
    const own = await db.query('select count(*)::int as n from public.workspaces where id = $1', [ws])
    if (own.rows[0].n > 0) left['workspaces.id'] = own.rows[0].n
    const docs = await db.query('select count(*)::int as n from public.documents where id = any($1::uuid[])', [documentIds])
    if (docs.rows[0].n > 0) left['documents.id'] = docs.rows[0].n
    return left
  })
}

async function objectsUnder(ws: string) {
  return withDb(async (db) => {
    const { rows } = await db.query("select name from storage.objects where bucket_id = 'documents' and name like $1 order by name", [`${ws}/%`])
    return rows.map((r) => r.name as string)
  })
}

async function objectExists(bucket: string, name: string) {
  return withDb(async (db) => (await db.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rowCount === 1)
}

async function upload(path: string, bucket = 'documents') {
  const { error } = await adminClient().storage.from(bucket).upload(path, PDF, { contentType: 'application/pdf' })
  if (error) throw error
}

/** Uploads many objects, a few at a time. */
async function uploadAll(paths: string[]) {
  for (let i = 0; i < paths.length; i += 20) await Promise.all(paths.slice(i, i + 20).map((p) => upload(p)))
}

async function workspaceExists(ws: string) {
  return withDb(async (db) => (await db.query('select 1 from public.workspaces where id = $1', [ws])).rowCount === 1)
}

async function userExists(id: string) {
  return withDb(async (db) => ({
    auth: (await db.query('select 1 from auth.users where id = $1', [id])).rowCount === 1,
    profile: (await db.query('select 1 from public.profiles where id = $1', [id])).rowCount === 1,
  }))
}

async function setSubscription(ws: string, id: string | null) {
  await withDb((db) => db.query('update public.workspaces set stripe_subscription_id = $2 where id = $1', [ws, id]))
}

async function newWorkspace(owner: TestUser, name: string): Promise<string> {
  const { data, error } = await owner.client.rpc('create_workspace', { name })
  if (error) throw error
  return data as string
}

async function accountPages(userId: string): Promise<number | null> {
  return withDb(async (db) => (await db.query('select pages_used from public.account_page_usage where user_id = $1', [userId])).rows[0]?.pages_used ?? null)
}

async function workspacePages(ws: string): Promise<number> {
  return withDb(async (db) => (await db.query(`select pages_used from public.page_usage where workspace_id = $1 and period_start = ${MONTH}`, [ws])).rows[0]?.pages_used ?? 0)
}

/** A document with its pages held, in the given status, with its object stored. */
async function heldDocument(user: TestUser, ws: string, pages: number, status: string, withFile = false) {
  const doc = await createDocument(user, ws)
  if (withFile) await upload(doc.storage_path)
  await withDb(async (db) => {
    await db.query('update public.documents set page_count = $2 where id = $1', [doc.id, pages])
    await db.query('begin')
    await asServiceRole(db)
    const reserved = await db.query<{ ok: boolean }>('select public.reserve_pages($1) as ok', [doc.id])
    if (!reserved.rows[0].ok) throw new Error('reserve_pages refused the test document')
    await db.query('reset role')
    await db.query('update public.documents set status = $2 where id = $1', [doc.id, status])
    await db.query('commit')
  })
  return doc
}

function invoiceResult() {
  const input = {
    ...Object.fromEntries(INVOICE_FIELDS.map((d) => [d.name, f('')])),
    vendor_name: f('Acme GmbH'),
    invoice_number: f(`INV-${randomUUID().slice(0, 8)}`),
    currency: f('EUR'),
    currency_as_printed: f('€'),
    invoice_date: f('2026-10-01'),
    subtotal: f('100.00'),
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
  return {
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
  }
}

/** record_extraction, as process-queue calls it, for a document in processing. */
async function record(id: string, result: Record<string, unknown>) {
  await withDb(async (db) => {
    await db.query('begin')
    await asServiceRole(db)
    await db.query('select public.record_extraction($1, null, $2)', [id, result])
    await db.query('commit')
  })
}

const FAILED = {
  outcome: 'fatal_error',
  status: 'failed',
  status_reason: 'Claude could not read this file.',
  model: 'claude-sonnet-5-5',
  prompt_version: 'test',
  error: 'Claude could not read this file.',
  input_tokens: null,
  output_tokens: null,
  cost_usd: 0,
}

/** An extracted document: fields, check results, an extraction, an extracted event and a tick. */
async function extractedDocument(user: TestUser, ws: string, withFile = true) {
  const doc = await heldDocument(user, ws, 1, 'processing', withFile)
  await record(doc.id, invoiceResult())
  const { error } = await user.client.rpc('set_check_ticked', { document_id: doc.id, check_id: 'A1', ticked: true })
  if (error) throw error
  return doc
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DELETE /api/workspaces/[id]: who may (criterion 1, ruling 1)', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string
  let doc: { id: string; storage_path: string }

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
    doc = await extractedDocument(owner, ws)
    await setSubscription(ws, 'sub_who_may')
  })

  async function expectNothingChanged() {
    expect(await workspaceExists(ws)).toBe(true)
    expect(await objectExists('documents', doc.storage_path)).toBe(true)
    await withDb(async (db) => {
      expect((await db.query('select count(*)::int as n from public.workspace_members where workspace_id = $1', [ws])).rows[0].n).toBe(2)
      expect((await db.query('select 1 from public.documents where id = $1', [doc.id])).rowCount).toBe(1)
    })
  }

  it('answers 401 with no session', async () => {
    const { stripe, cancel } = fakeStripe()
    const result = await deleteWorkspace(ws, { asCaller: anonClient(), admin: adminClient, stripe })
    expect(result.status).toBe(401)
    expect(cancel).not.toHaveBeenCalled()
    await expectNothingChanged()
  })

  it('answers 404 to an id that is not a UUID', async () => {
    const { stripe, cancel } = fakeStripe()
    const result = await deleteWorkspace('not-a-uuid', { asCaller: owner.client, admin: adminClient, stripe })
    expect(result.status).toBe(404)
    expect(cancel).not.toHaveBeenCalled()
    await expectNothingChanged()
  })

  it('answers 404 to someone who is not a member, and to a workspace that does not exist', async () => {
    const { stripe, cancel } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: stranger.client, admin: adminClient, stripe })).status).toBe(404)
    expect((await deleteWorkspace(randomUUID(), { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(404)
    expect(cancel).not.toHaveBeenCalled()
    await expectNothingChanged()
  })

  it('answers 403 to a member who is not an owner', async () => {
    const { stripe, cancel } = fakeStripe()
    const result = await deleteWorkspace(ws, { asCaller: member.client, admin: adminClient, stripe })
    expect(result.status).toBe(403)
    expect(cancel).not.toHaveBeenCalled()
    await expectNothingChanged()
  })

  it('answers 204 to an owner, and 404 when run again', async () => {
    const { stripe, cancel } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)
    expect(cancel).toHaveBeenCalledWith('sub_who_may')
    expect(await workspaceExists(ws)).toBe(false)
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(404)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('what deleting a workspace removes (criterion 2, ruling 3)', () => {
  const demoFile = `access-deletion-${randomUUID()}.pdf`

  afterAll(async () => {
    await adminClient().storage.from('demo').remove([demoFile])
  })

  it('removes every row and object of the workspace, and nothing of the demo bucket or another workspace', async () => {
    const owner = await signUp()
    const member = await signUp()
    const other = await signUp()
    const ws = await personalWorkspaceId(owner)
    const otherWs = await personalWorkspaceId(other)
    await addMember(ws, member, 'member')

    const extracted = await extractedDocument(owner, ws)
    const queued = await heldDocument(member, ws, 1, 'queued', true)
    const invited = await owner.client.rpc('create_invite', { ws, email: 'someone@example.test', role: 'member' })
    if (invited.error) throw invited.error
    // A file that outlived its row.
    await upload(`${ws}/${randomUUID()}/original`)
    await withDb((db) =>
      db.query("insert into public.document_events (document_id, workspace_id, kind, actor) values ($1, $2, 'retried', $3)", [extracted.id, ws, owner.id]),
    )

    const otherDoc = await extractedDocument(other, otherWs)
    await upload(demoFile, 'demo')

    const ids = [extracted.id, queued.id]
    // The check below reads something: these all hold a row of this workspace before the delete.
    const before = await rowsLeft(ws, ids)
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([
        'workspaces.id',
        'documents.id',
        'documents.workspace_id',
        'extraction_fields.document_id',
        'extraction_fields.workspace_id',
        'check_results.document_id',
        'check_ticks.document_id',
        'document_events.document_id',
        'extractions.document_id',
        'workspace_invites.workspace_id',
        'workspace_members.workspace_id',
        'page_usage.workspace_id',
      ]),
    )
    const tables = await withDb(keyedTables)
    expect(tables.length).toBeGreaterThanOrEqual(9)

    const { stripe } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)

    expect(await rowsLeft(ws, ids)).toEqual({})
    expect(await objectsUnder(ws)).toEqual([])

    expect(await workspaceExists(otherWs)).toBe(true)
    expect(await objectExists('demo', demoFile)).toBe(true)
    expect(Object.keys(await rowsLeft(otherWs, [otherDoc.id]))).toEqual(expect.arrayContaining(['documents.id', 'extraction_fields.document_id']))
    // The users stay, each with their own workspace or none.
    expect(await userExists(owner.id)).toEqual({ auth: true, profile: true })
  })

  it('removes more objects than one batch, in nested folders too', async () => {
    const owner = await signUp()
    const ws = await personalWorkspaceId(owner)
    const paths = [
      ...Array.from({ length: 110 }, () => `${ws}/${randomUUID()}/original`),
      ...Array.from({ length: 110 }, (_, i) => `${ws}/orphans/deep/nested/file-${i}.pdf`),
      `${ws}/at-the-top.pdf`,
    ]
    await uploadAll(paths)
    expect((await objectsUnder(ws)).length).toBe(paths.length)

    const { stripe } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)
    expect(await objectsUnder(ws)).toEqual([])
    expect(await workspaceExists(ws)).toBe(false)
  }, 60_000)
})

describe('a failure leaves a workspace that can be deleted again (criterion 3, ruling 2)', () => {
  async function fixture() {
    const owner = await signUp()
    const uploader = await signUp()
    const ws = await personalWorkspaceId(owner)
    await addMember(ws, uploader, 'member')
    const doc = await heldDocument(uploader, ws, 2, 'queued', true)
    return { owner, uploader, ws, doc }
  }

  async function expectFinishes(owner: TestUser, ws: string) {
    const { stripe } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)
    expect(await workspaceExists(ws)).toBe(false)
    expect(await objectsUnder(ws)).toEqual([])
  }

  it('when Stripe fails: 500, nothing removed, and a second run finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { owner, uploader, ws, doc } = await fixture()
    await setSubscription(ws, 'sub_fails')
    const { stripe, cancel } = fakeStripe(async () => {
      throw new Error('Stripe is having a moment')
    })
    const result = await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })
    expect(result.status).toBe(500)
    expect(cancel).toHaveBeenCalledWith('sub_fails')
    expect(await workspaceExists(ws)).toBe(true)
    expect(await objectExists('documents', doc.storage_path)).toBe(true)
    expect(await accountPages(uploader.id)).toBe(2)
    await expectFinishes(owner, ws)
    expect(await accountPages(uploader.id)).toBe(0)
  })

  it('when the listing fails: 500, and a second run finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { owner, ws, doc } = await fixture()
    const { stripe } = fakeStripe()
    const result = await deleteWorkspace(ws, { asCaller: owner.client, admin: failingStorage('list'), stripe })
    expect(result.status).toBe(500)
    expect(await workspaceExists(ws)).toBe(true)
    expect(await objectExists('documents', doc.storage_path)).toBe(true)
    await expectFinishes(owner, ws)
  })

  it('when a removal fails after some files went: 500, the row stays, and a second run finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { owner, uploader, ws } = await fixture()
    await uploadAll(Array.from({ length: 150 }, (_, i) => `${ws}/orphans/file-${i}.pdf`))
    const { stripe } = fakeStripe()
    const result = await deleteWorkspace(ws, { asCaller: owner.client, admin: failingStorage('remove', 1), stripe })
    expect(result.status).toBe(500)
    expect(await workspaceExists(ws)).toBe(true)
    const left = await objectsUnder(ws)
    expect(left.length).toBeGreaterThan(0)
    expect(left.length).toBeLessThan(151)
    // No pages go back before the files are gone.
    expect(await accountPages(uploader.id)).toBe(2)
    await expectFinishes(owner, ws)
  }, 60_000)

  it('when releasing pages fails: 500, the row stays, and a second run finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { owner, uploader, ws } = await fixture()
    const { stripe } = fakeStripe()
    const result = await deleteWorkspace(ws, { asCaller: owner.client, admin: failingAdmin({ rpc: 'release_pages' }), stripe })
    expect(result.status).toBe(500)
    expect(await workspaceExists(ws)).toBe(true)
    expect(await accountPages(uploader.id)).toBe(2)
    await expectFinishes(owner, ws)
    expect(await accountPages(uploader.id)).toBe(0)
  })

  it('when the row cannot be deleted: 500, and a second run gives no page back twice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { owner, uploader, ws } = await fixture()
    // Pages the uploader used elsewhere, which must survive both runs.
    await withDb((db) => db.query('update public.account_page_usage set pages_used = pages_used + 3 where user_id = $1', [uploader.id]))
    const { stripe } = fakeStripe()
    const result = await deleteWorkspace(ws, { asCaller: owner.client, admin: failingAdmin({ deleteFrom: 'workspaces' }), stripe })
    expect(result.status).toBe(500)
    expect(await workspaceExists(ws)).toBe(true)
    expect(await accountPages(uploader.id)).toBe(3)
    await expectFinishes(owner, ws)
    expect(await accountPages(uploader.id)).toBe(3)
  })
})

describe('held pages and queue messages (criterion 4, ruling 4)', () => {
  it.each(['uploading', 'queued', 'waiting_budget', 'processing'])('gives pages held by a document in %s back to its uploader', async (status) => {
    const owner = await signUp()
    const uploader = await signUp()
    const ws = await personalWorkspaceId(owner)
    await addMember(ws, uploader, 'member')
    await heldDocument(uploader, ws, 3, status)
    expect(await accountPages(uploader.id)).toBe(3)
    const { stripe } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)
    expect(await accountPages(uploader.id)).toBe(0)
  })

  it.each(['needs_review', 'approved'])('keeps pages already used by a document in %s', async (status) => {
    const owner = await signUp()
    const uploader = await signUp()
    const ws = await personalWorkspaceId(owner)
    await addMember(ws, uploader, 'member')
    await heldDocument(uploader, ws, 3, status)
    const { stripe } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)
    expect(await accountPages(uploader.id)).toBe(3)
  })

  it('gives back the held pages of more documents than a batch, and only those', async () => {
    const owner = await signUp()
    const uploader = await signUp()
    const ws = await personalWorkspaceId(owner)
    await addMember(ws, uploader, 'member')
    // Inserted directly: the free plan's limits would refuse this many.
    await withDb(async (db) => {
      await db.query(
        `insert into public.documents (workspace_id, uploaded_by, status, file_name, mime_type, byte_size, page_count, storage_path, pages_reserved, pages_period_start)
         select $1::uuid, $2::uuid, 'queued', 'x.pdf', 'application/pdf', 1, 1, $1::text || '/' || gen_random_uuid() || '/original', true, ${MONTH}
         from generate_series(1, 130)`,
        [ws, uploader.id],
      )
      await db.query('insert into public.account_page_usage (user_id, pages_used) values ($1, 135)', [uploader.id])
    })
    const { stripe } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)
    expect(await accountPages(uploader.id)).toBe(5)
  })

  it('a queue message left for a deleted workspace’s document is archived by the next process-queue run, with no spend and no error', async () => {
    const owner = await signUp()
    const ws = await personalWorkspaceId(owner)
    const doc = await heldDocument(owner, ws, 1, 'queued', true)
    const { stripe } = fakeStripe()
    expect((await deleteWorkspace(ws, { asCaller: owner.client, admin: adminClient, stripe })).status).toBe(204)

    // The message is sent only now, so the cron job cannot take the document while it still exists.
    const { msgId, cronSecret, spentBefore } = await withDb(async (db) => {
      const sent = await db.query('select public.extract_send($1) as msg_id', [doc.id])
      const id = sent.rows[0].msg_id as string
      // Any other test's message waits, so this run reads this one.
      await db.query("update pgmq.q_extract set vt = now() + interval '1 hour' where msg_id <> $1", [id])
      const secret = await db.query("select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'")
      const spent = await db.query('select coalesce(sum(spent_usd), 0)::text as spent from public.ai_spend_periods')
      return { msgId: id, cronSecret: secret.rows[0].decrypted_secret as string, spentBefore: spent.rows[0].spent as string }
    })

    const response = await fetch(`${apiUrl()}/functions/v1/process-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
      body: '{}',
    })
    const body = await response.json()
    expect(response.status).toBe(200)
    // 'empty' when the cron job got there first; it runs the same code.
    expect(['skipped', 'empty']).toContain(body.outcome)

    await withDb(async (db) => {
      expect((await db.query('select 1 from pgmq.q_extract where msg_id = $1', [msgId])).rowCount).toBe(0)
      expect((await db.query('select 1 from pgmq.a_extract where msg_id = $1', [msgId])).rowCount).toBe(1)
      const spent = await db.query('select coalesce(sum(spent_usd), 0)::text as spent from public.ai_spend_periods')
      expect(spent.rows[0].spent).toBe(spentBefore)
      expect((await db.query('select 1 from public.extractions where document_id = $1', [doc.id])).rowCount).toBe(0)
    })
  })
})

describe('DELETE /api/account: the refusal (criterion 5, ruling 5)', () => {
  it('answers 401 with no session', async () => {
    const result = await deleteAccount({ asCaller: anonClient(), admin: adminClient, stripe: noStripe })
    expect(result.status).toBe(401)
  })

  it('answers 409, naming the workspaces, while the caller is the only owner of a workspace with other members, and changes nothing at all', async () => {
    const user = await signUp()
    const teammate = await signUp()
    const personal = await personalWorkspaceId(user)
    const shared = await newWorkspace(user, 'Zebra books')
    const secondShared = await newWorkspace(user, 'Apple books')
    await addMember(shared, teammate, 'member')
    await addMember(secondShared, teammate, 'member')
    await setSubscription(personal, 'sub_never_touched')
    const doc = await heldDocument(user, personal, 1, 'queued', true)
    const { stripe, cancel } = fakeStripe()

    const result = await deleteAccount({ asCaller: user.client, admin: adminClient, stripe })

    expect(result.status).toBe(409)
    expect(result.workspaces).toEqual(['Apple books', 'Zebra books'])
    expect(result.error).toBe(
      'You are the only owner of Apple books, Zebra books, which still have other members. Make another member an owner of each, or delete it first.',
    )
    expect(cancel).not.toHaveBeenCalled()
    expect(await userExists(user.id)).toEqual({ auth: true, profile: true })
    for (const ws of [personal, shared, secondShared]) expect(await workspaceExists(ws)).toBe(true)
    expect(await objectExists('documents', doc.storage_path)).toBe(true)
    expect(await accountPages(user.id)).toBe(1)
    const session = await user.client.auth.getSession()
    expect(session.data.session).not.toBeNull()
  })

  it('does not refuse for a workspace with a second owner: the caller leaves it, and it stays', async () => {
    const user = await signUp()
    const owner = await signUp()
    const shared = await newWorkspace(owner, 'Two owners')
    await addMember(shared, user, 'owner')

    const result = await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: noStripe })

    expect(result.status).toBe(204)
    expect(await workspaceExists(shared)).toBe(true)
    await withDb(async (db) => {
      const { rows } = await db.query('select user_id from public.workspace_members where workspace_id = $1', [shared])
      expect(rows).toEqual([{ user_id: owner.id }])
    })
  })

  it('counts only actual members: a workspace with one member and pending invitations is deleted with them', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    const invited = await user.client.rpc('create_invite', { ws, email: 'pending@example.test', role: 'owner' })
    if (invited.error) throw invited.error

    const result = await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: noStripe })

    expect(result.status).toBe(204)
    expect(await rowsLeft(ws, [])).toEqual({})
  })

  it('deletes a workspace with one member whatever that member’s role', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    await withDb((db) => db.query("update public.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [ws, user.id]))

    const result = await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: noStripe })

    expect(result.status).toBe(204)
    expect(await workspaceExists(ws)).toBe(false)
  })
})

describe('DELETE /api/account: the deletion (criterion 5, ruling 6)', () => {
  it('deletes every sole-member workspace, with its files and subscription, then the user, and clears the session', async () => {
    const user = await signUp()
    const personal = await personalWorkspaceId(user)
    const second = await newWorkspace(user, 'Second')
    await setSubscription(second, 'sub_goes_with_account')
    const doc = await extractedDocument(user, personal)
    await upload(`${second}/${randomUUID()}/original`)
    const { stripe, cancel } = fakeStripe()

    const result = await deleteAccount({ asCaller: user.client, admin: adminClient, stripe })

    expect(result.status).toBe(204)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('sub_goes_with_account')
    expect(await rowsLeft(personal, [doc.id])).toEqual({})
    expect(await rowsLeft(second, [])).toEqual({})
    expect(await objectsUnder(personal)).toEqual([])
    expect(await objectsUnder(second)).toEqual([])
    expect(await userExists(user.id)).toEqual({ auth: false, profile: false })
    expect(await accountPages(user.id)).toBeNull()
    const session = await user.client.auth.getSession()
    expect(session.data.session).toBeNull()
  })

  it('works for a user with no workspace', async () => {
    const user = await signUp()
    await withDb((db) => db.query('delete from public.workspace_members where user_id = $1', [user.id]))
    const result = await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: noStripe })
    expect(result.status).toBe(204)
    expect(await userExists(user.id)).toEqual({ auth: false, profile: false })
  })

  it('answers 500 and keeps the user when a workspace cannot be deleted, and a second run finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = await signUp()
    const personal = await personalWorkspaceId(user)
    const second = await newWorkspace(user, 'Second')
    await setSubscription(personal, 'sub_personal')
    await setSubscription(second, 'sub_second')
    let calls = 0
    const failing = fakeStripe(async () => {
      calls += 1
      if (calls === 2) throw new Error('Stripe is having a moment')
      return { status: 'canceled' }
    })

    const first = await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: failing.stripe })

    expect(first.status).toBe(500)
    expect(await userExists(user.id)).toEqual({ auth: true, profile: true })
    expect((await workspaceExists(personal)) && (await workspaceExists(second))).toBe(false)
    expect((await workspaceExists(personal)) || (await workspaceExists(second))).toBe(true)

    const again = fakeStripe()
    expect((await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: again.stripe })).status).toBe(204)
    expect(await workspaceExists(personal)).toBe(false)
    expect(await workspaceExists(second)).toBe(false)
    expect(await userExists(user.id)).toEqual({ auth: false, profile: false })
  })

  it('answers 500 when the user cannot be deleted, and a second run finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = await signUp()
    const result = await deleteAccount({ asCaller: user.client, admin: failingAdmin({ deleteUser: true }), stripe: noStripe })
    expect(result.status).toBe(500)
    expect(await userExists(user.id)).toEqual({ auth: true, profile: true })
    expect((await user.client.auth.getSession()).data.session).not.toBeNull()

    expect((await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: noStripe })).status).toBe(204)
    expect(await userExists(user.id)).toEqual({ auth: false, profile: false })
  })

  it('still answers 204, and logs, when only clearing the session fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = await signUp()
    const asCaller = new Proxy(user.client, {
      get(target, prop) {
        if (prop !== 'auth') return Reflect.get(target, prop)
        return new Proxy(target.auth, {
          get(auth, method) {
            if (method === 'signOut') return async () => ({ error: { message: 'signOut failed' } })
            const value = Reflect.get(auth, method)
            return typeof value === 'function' ? value.bind(auth) : value
          },
        })
      },
    })
    const result = await deleteAccount({ asCaller, admin: adminClient, stripe: noStripe })
    expect(result.status).toBe(204)
    expect(error).toHaveBeenCalled()
    expect(await userExists(user.id)).toEqual({ auth: false, profile: false })
  })

  it('signs out only this session’s scope, as the caller', async () => {
    const user = await signUp()
    const signOut = vi.spyOn(user.client.auth, 'signOut')
    expect((await deleteAccount({ asCaller: user.client, admin: adminClient, stripe: noStripe })).status).toBe(204)
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

describe('a workspace that remains after an account is deleted (criterion 6, ruling 7)', () => {
  let owner: TestUser
  let leaver: TestUser
  let ws: string
  let extracted: { id: string; storage_path: string }
  let approved: { id: string; storage_path: string }
  let failed: { id: string; storage_path: string }
  let unsupported: { id: string; storage_path: string }
  let queued: { id: string; storage_path: string }
  let queuedToFail: { id: string; storage_path: string }
  let queuedToDelete: { id: string; storage_path: string }
  let pagesAfterDelete: number

  beforeAll(async () => {
    owner = await signUp()
    leaver = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, leaver, 'member')

    extracted = await extractedDocument(leaver, ws)
    approved = await extractedDocument(leaver, ws)
    await withDb((db) =>
      db.query("update public.documents set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [approved.id, leaver.id]),
    )
    failed = await heldDocument(leaver, ws, 1, 'processing', true)
    await record(failed.id, FAILED)
    unsupported = await heldDocument(leaver, ws, 1, 'processing', true)
    await record(unsupported.id, { ...FAILED, outcome: 'unsupported', status: 'unsupported', status_reason: 'Not a supported document type: a menu.', error: null })
    queued = await heldDocument(leaver, ws, 1, 'queued', true)
    queuedToFail = await heldDocument(leaver, ws, 1, 'queued', true)
    queuedToDelete = await heldDocument(leaver, ws, 2, 'queued', true)

    expect((await deleteAccount({ asCaller: leaver.client, admin: adminClient, stripe: noStripe })).status).toBe(204)
    pagesAfterDelete = await workspacePages(ws)
  })

  it('removes the membership and the account_page_usage row, and keeps the documents with a null uploader', async () => {
    await withDb(async (db) => {
      expect((await db.query('select 1 from public.workspace_members where user_id = $1', [leaver.id])).rowCount).toBe(0)
      expect((await db.query('select 1 from public.account_page_usage where user_id = $1', [leaver.id])).rowCount).toBe(0)
      const { rows } = await db.query('select uploaded_by, approved_by from public.documents where workspace_id = $1', [ws])
      expect(rows).toHaveLength(7)
      for (const row of rows) expect(row).toEqual({ uploaded_by: null, approved_by: null })
    })
    expect(await objectExists('documents', extracted.storage_path)).toBe(true)
  })

  it('the review screen’s history reads the upload with no actor, which it shows as "a deleted user" (e2e/deletion.spec.ts)', async () => {
    const data = await loadReview(owner.client, extracted.id)
    const uploaded = data!.events.find((e) => e.kind === 'uploaded')!
    expect(uploaded.actor).toBeNull()
    expect(data!.document.uploaded_by).toBeNull()
  })

  it('another member can correct and approve a document with no uploader', async () => {
    const corrected = await owner.client
      .from('extraction_fields')
      .update({ corrected_value: 'Acme Corrected GmbH' })
      .eq('document_id', extracted.id)
      .eq('path', 'vendor_name')
      .select('corrected_value')
    expect(corrected.error).toBeNull()
    expect(corrected.data).toEqual([{ corrected_value: 'Acme Corrected GmbH' }])
    const { error } = await owner.client.functions.invoke('approve-document', { body: { document_id: extracted.id } })
    expect(error).toBeNull()
    await withDb(async (db) => {
      const { rows } = await db.query('select status, approved_by, uploaded_by from public.documents where id = $1', [extracted.id])
      expect(rows).toEqual([{ status: 'approved', approved_by: owner.id, uploaded_by: null }])
    })
  })

  it('another member can reopen a document whose uploader and approver are gone', async () => {
    const { error } = await owner.client.rpc('reopen_document', { document_id: approved.id })
    expect(error).toBeNull()
  })

  it('another member can retry a failed document with no uploader: pages count against the workspace, and no account row appears', async () => {
    await rolledBack(async (db) => {
      await asUser(db, owner.id)
      await db.query('select public.retry_document($1)', [failed.id])
      await db.query('reset role')
      const { rows } = await db.query('select status, attempts, pages_reserved, uploaded_by from public.documents where id = $1', [failed.id])
      expect(rows).toEqual([{ status: 'queued', attempts: 0, pages_reserved: true, uploaded_by: null }])
      const pages = await db.query(`select pages_used from public.page_usage where workspace_id = $1 and period_start = ${MONTH}`, [ws])
      expect(pages.rows[0].pages_used).toBe(pagesAfterDelete + 1)
      const message = await db.query("select message from pgmq.q_extract where message ->> 'document_id' = $1", [failed.id])
      expect(message.rowCount).toBe(1)
      const events = await db.query("select actor from public.document_events where document_id = $1 and kind = 'retried'", [failed.id])
      expect(events.rows).toEqual([{ actor: owner.id }])
    })
  })

  it('a retry with no uploader is still refused when the workspace’s pages are used up', async () => {
    await rolledBack(async (db) => {
      await db.query(`update public.page_usage set pages_used = 20 where workspace_id = $1 and period_start = ${MONTH}`, [ws])
      await asUser(db, owner.id)
      await expect(db.query('select public.retry_document($1)', [failed.id])).rejects.toThrow(/0 pages remain/)
    })
  })

  it('another member can change the type of a not supported document with no uploader', async () => {
    await rolledBack(async (db) => {
      await asUser(db, owner.id)
      await db.query("select public.change_document_type($1, 'receipt')", [unsupported.id])
      await db.query('reset role')
      const { rows } = await db.query('select status, doc_type, pages_reserved from public.documents where id = $1', [unsupported.id])
      expect(rows).toEqual([{ status: 'queued', doc_type: 'receipt', pages_reserved: true }])
    })
  })

  it('a document queued when the account was deleted can still be extracted, opened, corrected and approved', async () => {
    await withDb((db) => db.query("update public.documents set status = 'processing' where id = $1", [queued.id]))
    await record(queued.id, invoiceResult())
    const data = await loadReview(owner.client, queued.id)
    expect(data!.document.status).toBe('needs_review')
    expect(data!.document.uploaded_by).toBeNull()
    const corrected = await owner.client
      .from('extraction_fields')
      .update({ corrected_value: 'Acme Again GmbH' })
      .eq('document_id', queued.id)
      .eq('path', 'vendor_name')
      .select('id')
    expect(corrected.data).toHaveLength(1)
    const { error } = await owner.client.functions.invoke('approve-document', { body: { document_id: queued.id } })
    expect(error).toBeNull()
    await withDb(async (db) => expect((await db.query('select status from public.documents where id = $1', [queued.id])).rows).toEqual([{ status: 'approved' }]))
  })

  it('a document queued when the account was deleted gives its pages back to the workspace on failing, and can be retried', async () => {
    await withDb((db) => db.query("update public.documents set status = 'processing' where id = $1", [queuedToFail.id]))
    const before = await workspacePages(ws)
    await record(queuedToFail.id, FAILED)
    expect(await workspacePages(ws)).toBe(before - 1)
    await rolledBack(async (db) => {
      await asUser(db, owner.id)
      await db.query('select public.retry_document($1)', [queuedToFail.id])
      await db.query('reset role')
      const { rows } = await db.query('select status, pages_reserved from public.documents where id = $1', [queuedToFail.id])
      expect(rows).toEqual([{ status: 'queued', pages_reserved: true }])
    })
  })

  it('another member can delete a document queued when the account was deleted: pages back to the workspace, file gone', async () => {
    const before = await workspacePages(ws)
    const result = await deleteDocument(queuedToDelete.id, { asCaller: owner.client, admin: adminClient })
    expect(result.status).toBe(204)
    expect(await workspacePages(ws)).toBe(before - 2)
    expect(await objectExists('documents', queuedToDelete.storage_path)).toBe(false)
  })
})
