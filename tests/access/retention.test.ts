import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asServiceRole, asUser, rolledBack, withDb } from './local-db'
import { adminClient, anonClient, apiUrl, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// Milestone 10 (ARCHITECTURE.md sections 4.1, 7 and 8, PRD F12 and F14, issue #48 criteria 4, 5,
// 6, 8 and 10): get_budget_status, release_stale_spend_reservations, the two cron jobs, and a run
// of purge-files against the local stack with the local CRON_SECRET. The month and day spend rows
// are shared, so the database-function tests set them in a transaction they roll back.

const DAY = "(now() at time zone 'utc')::date"
const MONTH = "date_trunc('month', now() at time zone 'utc')::date"
const NEXT_MIDNIGHT = "(date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc'"
const NEXT_MONTH = "(date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc'"

type Db = pg.Client

/** Sets this month's and today's rows to the given spend and reservations. */
async function setSpend(db: Db, month: { spent: number; reserved?: number }, day: { spent: number; reserved?: number }) {
  await db.query(
    `insert into public.ai_spend_periods (period_start, cap_usd, spent_usd, reserved_usd) values (${MONTH}, 10, $1, $2)
     on conflict (period_start) do update set spent_usd = excluded.spent_usd, reserved_usd = excluded.reserved_usd`,
    [month.spent, month.reserved ?? 0],
  )
  await db.query(
    `insert into public.ai_spend_days (day, cap_usd, spent_usd, reserved_usd) values (${DAY}, 2, $1, $2)
     on conflict (day) do update set spent_usd = excluded.spent_usd, reserved_usd = excluded.reserved_usd`,
    [day.spent, day.reserved ?? 0],
  )
}

describe('get_budget_status', () => {
  let user: TestUser

  beforeAll(async () => {
    user = await signUp()
  })

  /** Calls it as the signed-in user, inside the transaction, with what resumes_at should be. */
  async function status(db: Db) {
    await asUser(db, user.id)
    const { rows } = await db.query(
      `select spent_usd, cap_usd, daily_reached, monthly_reached,
              case when resumes_at is null then null
                   when resumes_at = ${NEXT_MIDNIGHT} then 'next UTC midnight'
                   when resumes_at = ${NEXT_MONTH} then 'first of next UTC month'
                   else resumes_at::text end as resumes
       from public.get_budget_status()`,
    )
    await db.query('reset role')
    return rows[0]
  }

  // With app_config's values, one page costs at most
  // (4000 + 5000) × 2 / 1e6 + 8192 × 10 / 1e6 = 0.09992 USD.

  it('reports this month’s spend and cap, and no limit reached, when both have room', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, { spent: 1.234567 }, { spent: 0.5 })
      expect(await status(db)).toEqual({ spent_usd: '1.234567', cap_usd: '10.00', daily_reached: false, monthly_reached: false, resumes: null })
    })
  })

  it('reports the daily ceiling reached, resuming at the next UTC midnight', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, { spent: 3 }, { spent: 1.95 })
      expect(await status(db)).toEqual({ spent_usd: '3.000000', cap_usd: '10.00', daily_reached: true, monthly_reached: false, resumes: 'next UTC midnight' })
    })
  })

  it('reports the monthly cap reached, resuming on the first day of the next UTC month', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, { spent: 9.95 }, { spent: 0 })
      expect(await status(db)).toEqual({ spent_usd: '9.950000', cap_usd: '10.00', daily_reached: false, monthly_reached: true, resumes: 'first of next UTC month' })
    })
  })

  it('reports both reached, resuming at the later time: the first day of the next UTC month', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, { spent: 9.95 }, { spent: 1.95 })
      expect(await status(db)).toEqual({ spent_usd: '9.950000', cap_usd: '10.00', daily_reached: true, monthly_reached: true, resumes: 'first of next UTC month' })
    })
  })

  it('counts a limit reached only when what is left is below a one-page estimate, reservations included', async () => {
    await rolledBack(async (db) => {
      // Exactly one page's estimate left today: reserve_spend would still accept it.
      await setSpend(db, { spent: 0 }, { spent: 1.90008 })
      expect((await status(db)).daily_reached).toBe(false)
      await setSpend(db, { spent: 0 }, { spent: 1.900081 })
      expect((await status(db)).daily_reached).toBe(true)
      // What is reserved is not yet spent, but it is not left either.
      await setSpend(db, { spent: 0, reserved: 9.95 }, { spent: 0 })
      expect(await status(db)).toMatchObject({ spent_usd: '0.000000', monthly_reached: true })
    })
  })

  it('reads both caps from app_config now, not the caps the rows recorded', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, { spent: 9.95 }, { spent: 1.95 })
      await db.query('update public.app_config set spend_cap_usd = 20, daily_cap_usd = 5')
      expect(await status(db)).toEqual({ spent_usd: '9.950000', cap_usd: '20.00', daily_reached: false, monthly_reached: false, resumes: null })
      await db.query('update public.app_config set daily_cap_usd = 0')
      expect(await status(db)).toMatchObject({ daily_reached: true, resumes: 'next UTC midnight' })
    })
  })

  it('reports no spend for a month with no row yet', async () => {
    await rolledBack(async (db) => {
      await db.query(`delete from public.ai_spend_periods where period_start = ${MONTH}`)
      await db.query(`delete from public.ai_spend_days where day = ${DAY}`)
      expect(await status(db)).toEqual({ spent_usd: '0', cap_usd: '10.00', daily_reached: false, monthly_reached: false, resumes: null })
    })
  })

  it('is allowed to a signed-in user through the API and refused to anon', async () => {
    const allowed = await user.client.rpc('get_budget_status').single()
    expect(allowed.error).toBeNull()
    expect(Object.keys(allowed.data as object).sort()).toEqual(['cap_usd', 'daily_reached', 'monthly_reached', 'resumes_at', 'spent_usd'])
    const refused = await anonClient().rpc('get_budget_status')
    expect(refused.error?.code).toBe('42501')
  })
})

describe('release_stale_spend_reservations', () => {
  let doc: string

  beforeAll(async () => {
    const user = await signUp()
    doc = (await createDocument(user, await personalWorkspaceId(user))).id
  })

  async function reserve(db: Db, estimate: number, age: string): Promise<string> {
    await asServiceRole(db)
    const { rows } = await db.query('select reservation from public.reserve_spend($1, $2)', [doc, estimate])
    await db.query('reset role')
    await db.query(`update public.ai_spend_reservations set created_at = now() - $2::interval where id = $1`, [rows[0].reservation, age])
    return rows[0].reservation
  }

  async function spendRows(db: Db) {
    const period = await db.query(`select spent_usd, reserved_usd from public.ai_spend_periods where period_start = ${MONTH}`)
    const day = await db.query(`select spent_usd, reserved_usd from public.ai_spend_days where day = ${DAY}`)
    return { period: period.rows[0], day: day.rows[0] }
  }

  async function release(db: Db): Promise<number> {
    await asServiceRole(db)
    const { rows } = await db.query<{ n: number }>('select public.release_stale_spend_reservations() as n')
    await db.query('reset role')
    return rows[0].n
  }

  it('releases a 20-minute-old unsettled reservation and leaves a 5-minute-old one, adding nothing to spent_usd', async () => {
    await rolledBack(async (db) => {
      // Only this test's reservations are unsettled.
      await db.query('update public.ai_spend_reservations set settled_at = now() where settled_at is null')
      await setSpend(db, { spent: 1 }, { spent: 0.5 })
      const old = await reserve(db, 0.1, '20 minutes')
      const recent = await reserve(db, 0.2, '5 minutes')
      expect(await spendRows(db)).toEqual({
        period: { spent_usd: '1.000000', reserved_usd: '0.300000' },
        day: { spent_usd: '0.500000', reserved_usd: '0.300000' },
      })

      expect(await release(db)).toBe(1)
      expect(await spendRows(db)).toEqual({
        period: { spent_usd: '1.000000', reserved_usd: '0.200000' },
        day: { spent_usd: '0.500000', reserved_usd: '0.200000' },
      })
      const r = await db.query('select id, settled_at is not null as closed from public.ai_spend_reservations where id = any($1) order by estimate_usd', [
        [old, recent],
      ])
      expect(r.rows).toEqual([
        { id: old, closed: true },
        { id: recent, closed: false },
      ])

      // Released once: a second run releases nothing, and a late settle of it changes nothing.
      expect(await release(db)).toBe(0)
      await asServiceRole(db)
      await db.query('select public.settle_spend($1, 0.05)', [old])
      await db.query('reset role')
      expect((await spendRows(db)).day).toEqual({ spent_usd: '0.500000', reserved_usd: '0.200000' })
    })
  })

  it('gives the estimate back to the day row it was added to, not today’s', async () => {
    await rolledBack(async (db) => {
      await db.query('update public.ai_spend_reservations set settled_at = now() where settled_at is null')
      await setSpend(db, { spent: 0, reserved: 0.3 }, { spent: 0, reserved: 0.05 })
      await db.query(
        `insert into public.ai_spend_days (day, cap_usd, spent_usd, reserved_usd) values (${DAY} - 1, 2, 0.4, 0.3)
         on conflict (day) do update set spent_usd = 0.4, reserved_usd = 0.3`,
      )
      await db.query(
        `insert into public.ai_spend_reservations (document_id, period_start, day, estimate_usd, created_at)
         values ($1, ${MONTH}, ${DAY} - 1, 0.3, now() - interval '1 day')`,
        [doc],
      )
      expect(await release(db)).toBe(1)
      const yesterday = await db.query(`select spent_usd, reserved_usd from public.ai_spend_days where day = ${DAY} - 1`)
      expect(yesterday.rows).toEqual([{ spent_usd: '0.400000', reserved_usd: '0.000000' }])
      expect(await spendRows(db)).toEqual({
        period: { spent_usd: '0.000000', reserved_usd: '0.000000' },
        day: { spent_usd: '0.000000', reserved_usd: '0.050000' },
      })
    })
  })

  it('is refused to a member and to anon', async () => {
    const user = await signUp()
    for (const client of [user.client, anonClient()]) {
      const { error } = await client.rpc('release_stale_spend_reservations')
      expect(error?.code).toBe('42501')
    }
  })
})

describe('the purge-files and cron history jobs', () => {
  it('runs purge-files daily at 03:00 UTC through pg_net with the Vault entries process-queue reads', async () => {
    const jobs = await withDb(async (db) => (await db.query("select schedule, command, active from cron.job where jobname = 'purge-files'")).rows)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ schedule: '0 3 * * *', active: true })
    for (const part of ['net.http_post', "'/purge-files'", 'vault.decrypted_secrets', 'functions_base_url', 'cron_secret', 'x-cron-secret']) {
      expect(jobs[0].command).toContain(part)
    }
  })

  it('deletes cron.job_run_details rows older than 7 days, daily, in plain SQL (ruling 2)', async () => {
    const jobs = await withDb(async (db) => (await db.query("select schedule, command, active from cron.job where jobname = 'cron-history-cleanup'")).rows)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ schedule: '30 3 * * *', active: true })
    expect(jobs[0].command).not.toContain('http_post')
    await rolledBack(async (db) => {
      const { rows } = await db.query<{ jobid: string }>("select jobid from cron.job where jobname = 'process-queue'")
      const insert = `insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
        values ($1, $2, 1, 'postgres', 'postgres', 'test', 'succeeded', '1 row', now() - $3::interval, now() - $3::interval) returning runid`
      const old = (await db.query(insert, [rows[0].jobid, -1001, '8 days'])).rows[0].runid
      const recent = (await db.query(insert, [rows[0].jobid, -1002, '6 days'])).rows[0].runid
      await db.query(jobs[0].command)
      const left = await db.query('select runid from cron.job_run_details where runid = any($1)', [[old, recent]])
      expect(left.rows).toEqual([{ runid: recent }])
    })
  })
})

// The purge run itself, against the local stack. It acts on every document of the local database,
// so this test checks its own rows; the counts include any older rows left by earlier runs.
describe('a purge-files run', () => {
  const PDF = new TextEncoder().encode('%PDF-1.7\n%purge test\n')
  let user: TestUser
  let ws: string
  let cronSecret: string
  const demoFile = `access-purge-${randomUUID()}.pdf`

  /** A document of the given age, in the given status, with its object in the documents bucket. */
  async function storedDocument(age: string, status: string, pages = 1) {
    const { id, storage_path } = await createDocument(user, ws)
    const upload = await adminClient().storage.from('documents').upload(storage_path, PDF, { contentType: 'application/pdf' })
    if (upload.error) throw upload.error
    await withDb((db) =>
      db.query('update public.documents set status = $2, page_count = $3, created_at = now() - $4::interval where id = $1', [id, status, pages, age]),
    )
    return { id, path: storage_path }
  }

  async function objectExists(bucket: string, name: string) {
    return withDb(async (db) => (await db.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rowCount === 1)
  }

  async function documentRow(id: string) {
    return withDb(async (db) => {
      const { rows } = await db.query(
        'select status, pages_reserved, file_deleted_at is not null as file_deleted, approved_by from public.documents where id = $1',
        [id],
      )
      return rows[0] ?? null
    })
  }

  async function usage() {
    return withDb(async (db) => {
      const w = await db.query(`select pages_used from public.page_usage where workspace_id = $1 and period_start = ${MONTH}`, [ws])
      const a = await db.query('select pages_used from public.account_page_usage where user_id = $1', [user.id])
      return { workspace: w.rows[0]?.pages_used ?? 0, account: a.rows[0]?.pages_used ?? 0 }
    })
  }

  async function purge(headers: Record<string, string>) {
    const response = await fetch(`${apiUrl()}/functions/v1/purge-files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  let old: { id: string; path: string }
  let young: { id: string; path: string }
  let stale: { id: string; path: string }
  let fresh: { id: string; path: string }
  let staleReservation: string

  beforeAll(async () => {
    user = await signUp()
    ws = await personalWorkspaceId(user)
    cronSecret = await withDb(async (db) => (await db.query("select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'")).rows[0].decrypted_secret)

    // 8 days old and approved, with a field, a check, a tick and an event.
    old = await storedDocument('8 days', 'needs_review')
    await withDb(async (db) => {
      await db.query(
        `insert into public.extraction_fields (document_id, workspace_id, path, kind, extracted_value, confidence) values ($1, $2, 'total', 'amount', '119.00', 0.95)`,
        [old.id, ws],
      )
      await db.query(
        `insert into public.check_results (document_id, workspace_id, check_id, status, field_paths, message, evaluated_at) values ($1, $2, 'D2', 'fail', '{due_date}', 'Due before issued', now())`,
        [old.id, ws],
      )
      await db.query('insert into public.check_ticks (document_id, workspace_id, check_id, ticked_by) values ($1, $2, $3, $4)', [old.id, ws, 'D2', user.id])
      await db.query("insert into public.document_events (document_id, workspace_id, kind, actor) values ($1, $2, 'approved', $3)", [old.id, ws, user.id])
      await db.query("update public.documents set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [old.id, user.id])
    })
    young = await storedDocument('6 days', 'needs_review')

    // Left uploading two hours ago with two pages reserved, as when submit-document fails after
    // reserve_pages (ruling 3); and one left 30 minutes ago, which is not stale yet.
    stale = await storedDocument('2 hours', 'uploading', 2)
    await withDb(async (db) => {
      await db.query('begin')
      await asServiceRole(db)
      await db.query('select public.reserve_pages($1)', [stale.id])
      await db.query('commit')
    })
    fresh = await storedDocument('30 minutes', 'uploading')

    // A spend reservation a killed run left 20 minutes ago.
    staleReservation = await withDb(async (db) => {
      await db.query('begin')
      await asServiceRole(db)
      const { rows } = await db.query('select reservation from public.reserve_spend($1, 0.01)', [young.id])
      await db.query('reset role')
      await db.query("update public.ai_spend_reservations set created_at = now() - interval '20 minutes' where id = $1", [rows[0].reservation])
      await db.query('commit')
      return rows[0].reservation as string
    })

    // A demo object far older than 7 days (ruling 5).
    const demo = await adminClient().storage.from('demo').upload(demoFile, PDF, { contentType: 'application/pdf' })
    if (demo.error) throw demo.error
    await withDb((db) =>
      db.query("update storage.objects set created_at = now() - interval '30 days', updated_at = now() - interval '30 days' where bucket_id = 'demo' and name = $1", [demoFile]),
    )
  })

  afterAll(async () => {
    await adminClient().storage.from('demo').remove([demoFile])
  })

  it('answers 401 to a request without the secret, or with a wrong one, and changes nothing', async () => {
    const before = await usage()
    for (const headers of [{}, { 'x-cron-secret': 'wrong' }, { Authorization: `Bearer ${cronSecret}` }]) {
      expect((await purge(headers)).status).toBe(401)
    }
    expect(await objectExists('documents', old.path)).toBe(true)
    expect(await documentRow(old.id)).toMatchObject({ file_deleted: false })
    expect(await documentRow(stale.id)).toMatchObject({ status: 'uploading', pages_reserved: true })
    expect(await objectExists('documents', stale.path)).toBe(true)
    expect(await usage()).toEqual(before)
    const r = await withDb((db) => db.query('select settled_at from public.ai_spend_reservations where id = $1', [staleReservation]))
    expect(r.rows).toEqual([{ settled_at: null }])
  })

  it('with the local CRON_SECRET, removes what is due, keeps the rest and answers with the counts', async () => {
    const before = await usage()
    const { status, body } = await purge({ 'x-cron-secret': cronSecret })
    console.info('purge-files answered', status, JSON.stringify(body))
    expect(status).toBe(200)
    expect(body).toEqual({
      files_removed: expect.any(Number),
      files_failed: 0,
      stale_uploads_removed: expect.any(Number),
      reservations_released: expect.any(Number),
    })
    expect(body.files_removed).toBeGreaterThanOrEqual(1)
    expect(body.stale_uploads_removed).toBeGreaterThanOrEqual(1)
    expect(body.reservations_released).toBeGreaterThanOrEqual(1)

    // 8 days old: the object is gone and file_deleted_at is set; the approval, fields, check,
    // tick and history stay (US-14.1 AC-5).
    expect(await objectExists('documents', old.path)).toBe(false)
    expect(await documentRow(old.id)).toEqual({ status: 'approved', pages_reserved: false, file_deleted: true, approved_by: user.id })
    const kept = await withDb(async (db) => ({
      fields: (await db.query('select path, extracted_value from public.extraction_fields where document_id = $1', [old.id])).rows,
      checks: (await db.query('select check_id, status from public.check_results where document_id = $1', [old.id])).rows,
      ticks: (await db.query('select check_id from public.check_ticks where document_id = $1', [old.id])).rows,
      events: (await db.query('select kind from public.document_events where document_id = $1', [old.id])).rows,
    }))
    expect(kept).toEqual({
      fields: [{ path: 'total', extracted_value: '119.00' }],
      checks: [{ check_id: 'D2', status: 'fail' }],
      ticks: [{ check_id: 'D2' }],
      events: [{ kind: 'approved' }],
    })

    // 6 days old: untouched.
    expect(await objectExists('documents', young.path)).toBe(true)
    expect(await documentRow(young.id)).toMatchObject({ file_deleted: false })

    // Uploading for two hours: gone with its object, its two pages given back (ruling 3).
    expect(await documentRow(stale.id)).toBeNull()
    expect(await objectExists('documents', stale.path)).toBe(false)
    expect(await usage()).toEqual({ workspace: before.workspace - 2, account: before.account - 2 })
    // Uploading for 30 minutes: still there.
    expect(await documentRow(fresh.id)).toMatchObject({ status: 'uploading' })
    expect(await objectExists('documents', fresh.path)).toBe(true)

    // The reservation is released, and the demo object is still there.
    const r = await withDb((db) => db.query('select settled_at is not null as closed from public.ai_spend_reservations where id = $1', [staleReservation]))
    expect(r.rows).toEqual([{ closed: true }])
    expect(await objectExists('demo', demoFile)).toBe(true)
  })

  it('removes nothing more on a second run, and never touches the demo bucket', async () => {
    const { status, body } = await purge({ 'x-cron-secret': cronSecret })
    expect(status).toBe(200)
    expect(body).toMatchObject({ files_failed: 0 })
    expect(await objectExists('documents', young.path)).toBe(true)
    expect(await objectExists('demo', demoFile)).toBe(true)
    const listed = await adminClient().storage.from('demo').list('', { limit: 1000 })
    expect(listed.data?.map((o) => o.name)).toContain(demoFile)
  })
})
