import type pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { asServiceRole, asUser, rolledBack, withDb } from './local-db'
import { addMember, adminClient, anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// The extraction pipeline's database functions (ARCHITECTURE.md sections 4.1, 6.3, 6.4 and 7,
// milestone 5, Lead rulings 1, 2 and 7 on #24): the queue wrappers, release_pages and the month a
// reservation counted against, account_page_cap read from app_config, record_extraction and
// retry_document. Calls that change shared state run in a transaction that is rolled back.

const MONTH = "date_trunc('month', now() at time zone 'utc')::date"
const LAST_MONTH = "(date_trunc('month', now() at time zone 'utc') - interval '1 month')::date"

type Db = pg.Client

async function usage(db: Db, ws: string, user: string, period = MONTH) {
  const w = await db.query(`select pages_used from public.page_usage where workspace_id = $1 and period_start = ${period}`, [ws])
  const a = await db.query('select pages_used from public.account_page_usage where user_id = $1', [user])
  return { workspace: w.rows[0]?.pages_used ?? 0, account: a.rows[0]?.pages_used ?? 0 }
}

async function doc(db: Db, id: string) {
  const { rows } = await db.query(
    `select status, status_reason, attempts, pages_reserved, pages_period_start = ${MONTH} as this_month,
            doc_type, doc_type_source, processed_at is not null as processed
     from public.documents where id = $1`,
    [id],
  )
  return rows[0]
}

/** A document as submit-document leaves it: pages counted on the row, then reserved. */
async function reservedDocument(user: TestUser, ws: string, pages: number, status = 'queued'): Promise<string> {
  const { id } = await createDocument(user, ws)
  await withDb(async (db) => {
    await db.query('update public.documents set page_count = $2 where id = $1', [id, pages])
    await db.query('begin')
    await asServiceRole(db)
    await db.query('select public.reserve_pages($1)', [id])
    await db.query('reset role')
    await db.query('update public.documents set status = $2 where id = $1', [id, status])
    await db.query('commit')
  })
  return id
}

describe('the extract queue wrappers', () => {
  it('send, read, delay and archive messages on extract, as the service role', async () => {
    const user = await signUp()
    const { id } = await createDocument(user, await personalWorkspaceId(user))
    await rolledBack(async (db) => {
      await asServiceRole(db)
      const sent = await db.query<{ id: string }>('select public.extract_send($1) as id', [id])
      const msgId = sent.rows[0].id
      const read = await db.query('select msg_id, read_ct, message from public.extract_read(30, 1000)')
      expect(read.rows).toContainEqual({ msg_id: msgId, read_ct: 1, message: { document_id: id } })

      await db.query('select public.extract_set_vt($1, 600)', [msgId])
      await db.query('reset role')
      const vt = await db.query(
        `select vt > now() + interval '590 seconds' as delayed from pgmq.q_extract where msg_id = $1`,
        [msgId],
      )
      expect(vt.rows).toEqual([{ delayed: true }])

      await asServiceRole(db)
      const archived = await db.query('select public.extract_archive($1) as ok', [msgId])
      expect(archived.rows).toEqual([{ ok: true }])
      await db.query('reset role')
      const moved = await db.query('select message from pgmq.a_extract where msg_id = $1', [msgId])
      expect(moved.rows).toEqual([{ message: { document_id: id } }])
    })
  })

  it('refuses every wrapper to a member and to anon', async () => {
    const user = await signUp()
    const { id } = await createDocument(user, await personalWorkspaceId(user))
    const calls = [
      ['extract_send', { document_id: id }],
      ['extract_read', { vt: 30, qty: 1 }],
      ['extract_set_vt', { msg_id: 1, vt: 0 }],
      ['extract_archive', { msg_id: 1 }],
    ] as const
    for (const client of [user.client, anonClient()]) {
      for (const [fn, args] of calls) {
        const { error } = await client.rpc(fn, args)
        expect(error?.code, fn).toBe('42501')
      }
    }
  })

  it('does not expose pgmq to the API', async () => {
    const { error } = await adminClient().schema('pgmq_public' as 'public').rpc('send', { queue_name: 'extract', message: {} })
    expect(error).not.toBeNull()
  })
})

describe('the queue and its cron job', () => {
  it('has the extract queue and runs process-queue every 10 seconds through pg_net, reading Vault', async () => {
    const { queues, jobs, secrets } = await withDb(async (db) => ({
      queues: (await db.query("select queue_name from pgmq.list_queues() where queue_name = 'extract'")).rows,
      jobs: (await db.query("select schedule, command, active from cron.job where jobname = 'process-queue'")).rows,
      secrets: (
        await db.query(
          "select name from vault.decrypted_secrets where name in ('functions_base_url', 'cron_secret') order by name",
        )
      ).rows,
    }))
    expect(queues).toEqual([{ queue_name: 'extract' }])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ schedule: '10 seconds', active: true })
    for (const part of ['net.http_post', 'vault.decrypted_secrets', 'functions_base_url', 'cron_secret', 'extract_concurrency']) {
      expect(jobs[0].command).toContain(part)
    }
    // The local seed puts both Vault entries, so the job runs locally and in CI.
    expect(secrets).toEqual([{ name: 'cron_secret' }, { name: 'functions_base_url' }])
  })
})

describe('reserve_pages and release_pages', () => {
  let user: TestUser
  let ws: string

  beforeAll(async () => {
    user = await signUp()
    ws = await personalWorkspaceId(user)
  })

  it('reserve_pages records the month it counted against', async () => {
    const id = await reservedDocument(user, ws, 2)
    await withDb(async (db) => expect((await doc(db, id)).this_month).toBe(true))
  })

  it('release_pages gives the pages back to both rows and clears pages_reserved', async () => {
    const id = await reservedDocument(user, ws, 3)
    await rolledBack(async (db) => {
      const before = await usage(db, ws, user.id)
      await asServiceRole(db)
      await db.query('select public.release_pages($1)', [id])
      await db.query('reset role')
      expect(await usage(db, ws, user.id)).toEqual({ workspace: before.workspace - 3, account: before.account - 3 })
      expect((await doc(db, id)).pages_reserved).toBe(false)

      // A second release gives nothing more back.
      await asServiceRole(db)
      await db.query('select public.release_pages($1)', [id])
      await db.query('reset role')
      expect(await usage(db, ws, user.id)).toEqual({ workspace: before.workspace - 3, account: before.account - 3 })
    })
  })

  it('a document reserved in one month and released after the month changes leaves the new month untouched', async () => {
    const other = await signUp()
    const otherWs = await personalWorkspaceId(other)
    const id = await reservedDocument(other, otherWs, 4)
    await rolledBack(async (db) => {
      // As if the reservation had been made last month: move its count there.
      await db.query(`update public.page_usage set period_start = ${LAST_MONTH} where workspace_id = $1`, [otherWs])
      await db.query(`update public.documents set pages_period_start = ${LAST_MONTH} where id = $1`, [id])
      await db.query(`insert into public.page_usage (workspace_id, period_start, pages_used) values ($1, ${MONTH}, 6)`, [otherWs])

      await asServiceRole(db)
      await db.query('select public.release_pages($1)', [id])
      await db.query('reset role')
      expect(await usage(db, otherWs, other.id, LAST_MONTH)).toEqual({ workspace: 0, account: 0 })
      expect((await usage(db, otherWs, other.id)).workspace).toBe(6)
    })
  })

  it('refuses release_pages to a member and to anon', async () => {
    const id = await reservedDocument(user, ws, 1)
    for (const client of [user.client, anonClient()]) {
      expect((await client.rpc('release_pages', { document_id: id })).error?.code).toBe('42501')
    }
  })
})

describe('account_page_cap', () => {
  it('reads app_config.account_page_cap', async () => {
    await rolledBack(async (db) => {
      await db.query('update public.app_config set account_page_cap = 7')
      await asServiceRole(db)
      expect((await db.query('select public.account_page_cap() as cap')).rows).toEqual([{ cap: 7 }])
    })
  })

  it('turns the account cap off when the value is null', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    const { id } = await createDocument(user, ws)
    await rolledBack(async (db) => {
      await db.query('update public.app_config set account_page_cap = null')
      await db.query('insert into public.account_page_usage (user_id, pages_used) values ($1, 10)', [user.id])
      await db.query('update public.documents set page_count = 5 where id = $1', [id])
      await asServiceRole(db)
      expect((await db.query('select public.reserve_pages($1) as ok', [id])).rows).toEqual([{ ok: true }])
      await db.query('reset role')
      await asUser(db, user.id)
      const allowance = await db.query('select account_cap from public.get_page_allowance($1)', [ws])
      expect(allowance.rows).toEqual([{ account_cap: null }])
    })
  })
})

describe('record_extraction', () => {
  let user: TestUser
  let ws: string

  beforeAll(async () => {
    user = await signUp()
    ws = await personalWorkspaceId(user)
  })

  const fields = [
    { path: 'total', kind: 'amount', extracted_value: '120.00', confidence: 0.97, flags: [] },
    { path: 'vendor_name', kind: 'text', extracted_value: 'Acme', confidence: 0.6, flags: ['low_confidence'] },
  ]
  const checks = [{ check_id: 'A4', status: 'skipped', field_paths: ['total', 'amount_paid', 'amount_due'], message: null }]

  /** Reserves spend for the document and calls record_extraction, as process-queue does. */
  async function record(db: Db, id: string, result: Record<string, unknown>) {
    await asServiceRole(db)
    const r = await db.query('select reservation from public.reserve_spend($1, 0.05)', [id])
    const out = await db.query('select public.record_extraction($1, $2, $3) as result', [id, r.rows[0].reservation, result])
    await db.query('reset role')
    const settled = await db.query('select settled_at is not null as settled from public.ai_spend_reservations where id = $1', [
      r.rows[0].reservation,
    ])
    return { result: out.rows[0].result, settled: settled.rows[0]?.settled }
  }

  const base = {
    model: 'claude-sonnet-5-5',
    prompt_version: 'test',
    input_tokens: 1000,
    output_tokens: 200,
    cost_usd: 0.004,
  }

  it('stores an invoice: fields, checks, type detected, needs_review, spend settled, pages kept', async () => {
    const id = await reservedDocument(user, ws, 1, 'processing')
    await rolledBack(async (db) => {
      const before = await usage(db, ws, user.id)
      const { result, settled } = await record(db, id, {
        ...base,
        outcome: 'ok',
        status: 'needs_review',
        tool_name: 'record_invoice',
        doc_type: 'invoice',
        raw_output: { total: { value: '120.00', confidence: 0.97 } },
        fields,
        checks,
      })
      expect(result).toBe('recorded')
      expect(settled).toBe(true)
      expect(await doc(db, id)).toMatchObject({
        status: 'needs_review',
        status_reason: null,
        doc_type: 'invoice',
        doc_type_source: 'detected',
        processed: true,
        pages_reserved: true,
      })
      const f = await db.query(
        'select path, kind, extracted_value, confidence, flags, workspace_id from public.extraction_fields where document_id = $1 order by path',
        [id],
      )
      expect(f.rows).toEqual([
        { path: 'total', kind: 'amount', extracted_value: '120.00', confidence: '0.970', flags: [], workspace_id: ws },
        { path: 'vendor_name', kind: 'text', extracted_value: 'Acme', confidence: '0.600', flags: ['low_confidence'], workspace_id: ws },
      ])
      const c = await db.query('select check_id, status, field_paths, message from public.check_results where document_id = $1', [id])
      expect(c.rows).toEqual(checks)
      const e = await db.query('select outcome, tool_name, model, cost_usd, input_tokens from public.extractions where document_id = $1', [
        id,
      ])
      expect(e.rows).toEqual([
        { outcome: 'ok', tool_name: 'record_invoice', model: 'claude-sonnet-5-5', cost_usd: '0.004000', input_tokens: 1000 },
      ])
      expect(await usage(db, ws, user.id)).toEqual(before)
    })
  })

  it('stores not supported: no fields, status unsupported, pages released (OQ-1)', async () => {
    const id = await reservedDocument(user, ws, 2, 'processing')
    await rolledBack(async (db) => {
      const before = await usage(db, ws, user.id)
      await record(db, id, {
        ...base,
        outcome: 'unsupported',
        status: 'unsupported',
        status_reason: 'Not a supported document type: a letter.',
        tool_name: 'record_not_supported',
      })
      expect(await doc(db, id)).toMatchObject({ status: 'unsupported', status_reason: 'Not a supported document type: a letter.', pages_reserved: false })
      expect(await usage(db, ws, user.id)).toEqual({ workspace: before.workspace - 2, account: before.account - 2 })
      expect((await db.query('select 1 from public.extraction_fields where document_id = $1', [id])).rows).toEqual([])
    })
  })

  it('stores a fatal failure: status failed with its reason, pages released (OQ-10)', async () => {
    const id = await reservedDocument(user, ws, 1, 'processing')
    await rolledBack(async (db) => {
      const before = await usage(db, ws, user.id)
      await record(db, id, { ...base, outcome: 'fatal_error', status: 'failed', status_reason: 'Claude could not read this file.', error: '400' })
      expect(await doc(db, id)).toMatchObject({ status: 'failed', status_reason: 'Claude could not read this file.', pages_reserved: false })
      expect(await usage(db, ws, user.id)).toEqual({ workspace: before.workspace - 1, account: before.account - 1 })
      const e = await db.query('select outcome, error from public.extractions where document_id = $1', [id])
      expect(e.rows).toEqual([{ outcome: 'fatal_error', error: '400' }])
    })
  })

  it('stores a retryable failure: back to queued, pages still held', async () => {
    const id = await reservedDocument(user, ws, 1, 'processing')
    await rolledBack(async (db) => {
      const before = await usage(db, ws, user.id)
      await record(db, id, { ...base, outcome: 'retryable_error', status: 'queued', error: '529 overloaded', input_tokens: null, cost_usd: 0 })
      expect(await doc(db, id)).toMatchObject({ status: 'queued', pages_reserved: true })
      expect(await usage(db, ws, user.id)).toEqual(before)
    })
  })

  it('only settles spend when the document was deleted during the call', async () => {
    const id = await reservedDocument(user, ws, 1, 'processing')
    await rolledBack(async (db) => {
      await asServiceRole(db)
      const r = await db.query('select reservation from public.reserve_spend($1, 0.05)', [id])
      await db.query('reset role')
      await db.query('delete from public.documents where id = $1', [id])
      await asServiceRole(db)
      const out = await db.query('select public.record_extraction($1, $2, $3) as result', [
        id,
        r.rows[0].reservation,
        { ...base, outcome: 'ok', status: 'needs_review', doc_type: 'invoice', fields, checks },
      ])
      expect(out.rows).toEqual([{ result: 'deleted' }])
      const settled = await db.query('select settled_at is not null as settled from public.ai_spend_reservations where id = $1', [
        r.rows[0].reservation,
      ])
      expect(settled.rows).toEqual([{ settled: true }])
    })
  })

  it('refuses a status that is not an outcome of extraction', async () => {
    const id = await reservedDocument(user, ws, 1, 'processing')
    const code = await rolledBack(async (db) => {
      await asServiceRole(db)
      return db
        .query('select public.record_extraction($1, null, $2)', [id, { ...base, outcome: 'ok', status: 'approved' }])
        .then(
          () => null,
          (e: { code: string }) => e.code,
        )
    })
    expect(code).toBe('22023')
  })

  it('is refused to a member and to anon', async () => {
    const id = await reservedDocument(user, ws, 1, 'processing')
    for (const client of [user.client, anonClient()]) {
      const { error } = await client.rpc('record_extraction', { document_id: id, reservation: null, result: { status: 'needs_review' } })
      expect(error?.code).toBe('42501')
    }
    await withDb(async (db) => expect((await doc(db, id)).status).toBe('processing'))
  })
})

describe('retry_document', () => {
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

  /** A document that failed: its pages released, attempts used up. */
  async function failedDocument(pages = 1): Promise<string> {
    const id = await reservedDocument(owner, ws, pages, 'processing')
    await withDb(async (db) => {
      await db.query('begin')
      await asServiceRole(db)
      await db.query('select public.release_pages($1)', [id])
      await db.query('reset role')
      await db.query("update public.documents set status = 'failed', status_reason = 'Claude could not read this file.', attempts = 3 where id = $1", [
        id,
      ])
      await db.query('commit')
    })
    return id
  }

  it('lets a member retry: attempts reset, pages reserved again, a retried event, and a message on extract', async () => {
    const id = await failedDocument(2)
    await rolledBack(async (db) => {
      const before = await usage(db, ws, owner.id)
      await asUser(db, member.id)
      await db.query('select public.retry_document($1)', [id])
      await db.query('reset role')
      expect(await doc(db, id)).toMatchObject({ status: 'queued', status_reason: null, attempts: 0, pages_reserved: true, this_month: true })
      expect(await usage(db, ws, owner.id)).toEqual({ workspace: before.workspace + 2, account: before.account + 2 })
      const events = await db.query('select kind, actor, workspace_id from public.document_events where document_id = $1', [id])
      expect(events.rows).toEqual([{ kind: 'retried', actor: member.id, workspace_id: ws }])
      const messages = await db.query("select message from pgmq.q_extract where message ->> 'document_id' = $1", [id])
      expect(messages.rows).toEqual([{ message: { document_id: id } }])
    })
  })

  it('refuses a non-member and anon, and changes nothing', async () => {
    const id = await failedDocument()
    for (const client of [stranger.client, anonClient()]) {
      const { error } = await client.rpc('retry_document', { document_id: id })
      expect(error?.code).toBe('42501')
    }
    await withDb(async (db) => expect(await doc(db, id)).toMatchObject({ status: 'failed', attempts: 3, pages_reserved: false }))
  })

  it('refuses a document whose file is deleted', async () => {
    const id = await failedDocument()
    await withDb((db) => db.query('update public.documents set file_deleted_at = now() where id = $1', [id]))
    const { error } = await member.client.rpc('retry_document', { document_id: id })
    expect(error?.code).toBe('22023')
    expect(error?.message).toContain('file has been deleted')
    await withDb(async (db) => expect(await doc(db, id)).toMatchObject({ status: 'failed', pages_reserved: false }))
  })

  it('refuses a retry over an allowance, saying how many pages remain, and counts nothing', async () => {
    const id = await failedDocument(2)
    await withDb((db) =>
      db.query(
        `insert into public.account_page_usage (user_id, pages_used) values ($1, 9)
         on conflict (user_id) do update set pages_used = 9`,
        [owner.id],
      ),
    )
    const { error } = await member.client.rpc('retry_document', { document_id: id })
    expect(error?.code).toBe('22023')
    expect(error?.message).toContain('has 2 pages, but only 1 page remains')
    await withDb(async (db) => {
      expect(await doc(db, id)).toMatchObject({ status: 'failed', attempts: 3, pages_reserved: false })
      expect((await usage(db, ws, owner.id)).account).toBe(9)
    })
    await withDb((db) => db.query('update public.account_page_usage set pages_used = 0 where user_id = $1', [owner.id]))
  })

  it('refuses a document that has not failed', async () => {
    const id = await reservedDocument(owner, ws, 1, 'needs_review')
    const { error } = await member.client.rpc('retry_document', { document_id: id })
    expect(error?.code).toBe('22023')
    expect(error?.message).toContain('Only a failed document can be retried')
  })
})
