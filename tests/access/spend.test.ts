import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { asServiceRole, localDbUrl, rolledBack, withDb } from './local-db'
import { anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// reserve_spend and settle_spend (ARCHITECTURE.md section 7, PRD US-12.1, OQ-22, OQ-33, Lead
// ruling 8 on #24): $10 a UTC month and $2 a UTC day across all AI use, held with an upper-bound
// reservation before each Claude call and settled with the actual cost after it. The month and
// day rows are shared by every test, so each test sets them inside a transaction it rolls back.

const DAY = "(now() at time zone 'utc')::date"
const MONTH = "date_trunc('month', now() at time zone 'utc')::date"

type Db = pg.Client

/** Sets this month's and today's rows to the given spend, with nothing reserved. */
async function setSpend(db: Db, month: number, day: number) {
  await db.query(
    `insert into public.ai_spend_periods (period_start, cap_usd, spent_usd, reserved_usd) values (${MONTH}, 10, $1, 0)
     on conflict (period_start) do update set spent_usd = excluded.spent_usd, reserved_usd = 0`,
    [month],
  )
  await db.query(
    `insert into public.ai_spend_days (day, cap_usd, spent_usd, reserved_usd) values (${DAY}, 2, $1, 0)
     on conflict (day) do update set spent_usd = excluded.spent_usd, reserved_usd = 0`,
    [day],
  )
}

async function rows(db: Db) {
  const period = await db.query(`select cap_usd, spent_usd, reserved_usd from public.ai_spend_periods where period_start = ${MONTH}`)
  const day = await db.query(`select cap_usd, spent_usd, reserved_usd from public.ai_spend_days where day = ${DAY}`)
  return { period: period.rows[0], day: day.rows[0] }
}

async function reserve(db: Db, doc: string, estimate: number) {
  const { rows } = await db.query<{ reservation: string | null; refused_by: string | null }>(
    'select * from public.reserve_spend($1, $2)',
    [doc, estimate],
  )
  return rows[0]
}

describe('reserve_spend', () => {
  let user: TestUser
  let doc: string
  let doc2: string

  beforeAll(async () => {
    user = await signUp()
    const ws = await personalWorkspaceId(user)
    doc = (await createDocument(user, ws)).id
    doc2 = (await createDocument(user, ws)).id
  })

  it('reserves the estimate on this month’s and today’s rows', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 1, 0.5)
      await asServiceRole(db)
      const result = await reserve(db, doc, 0.1)
      expect(result.refused_by).toBeNull()
      expect(result.reservation).toMatch(/^[0-9a-f-]{36}$/)
      expect(await rows(db)).toEqual({
        period: { cap_usd: '10.00', spent_usd: '1.000000', reserved_usd: '0.100000' },
        day: { cap_usd: '2.00', spent_usd: '0.500000', reserved_usd: '0.100000' },
      })
      const r = await db.query(
        `select document_id, estimate_usd, period_start = ${MONTH} as this_month, day = ${DAY} as today, settled_at
         from public.ai_spend_reservations where id = $1`,
        [result.reservation],
      )
      expect(r.rows).toEqual([{ document_id: doc, estimate_usd: '0.100000', this_month: true, today: true, settled_at: null }])
    })
  })

  it('creates a missing month or day row with the cap in app_config', async () => {
    await rolledBack(async (db) => {
      await db.query(`delete from public.ai_spend_days where day = ${DAY}`)
      await db.query(`delete from public.ai_spend_periods where period_start = ${MONTH}`)
      await asServiceRole(db)
      expect((await reserve(db, doc, 0.25)).refused_by).toBeNull()
      expect(await rows(db)).toEqual({
        period: { cap_usd: '10.00', spent_usd: '0.000000', reserved_usd: '0.250000' },
        day: { cap_usd: '2.00', spent_usd: '0.000000', reserved_usd: '0.250000' },
      })
    })
  })

  it('refuses with daily a call that fits the $10 month but would pass the $2 UTC day', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 3, 1.95)
      await asServiceRole(db)
      expect(await reserve(db, doc, 0.1)).toEqual({ reservation: null, refused_by: 'daily' })
      // Nothing is held, and no reservation is recorded.
      expect((await rows(db)).day.reserved_usd).toBe('0.000000')
      const r = await db.query('select 1 from public.ai_spend_reservations where document_id = $1', [doc])
      expect(r.rows).toEqual([])
    })
  })

  it('counts what is already reserved, not only what is spent', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 0, 1.5)
      await asServiceRole(db)
      expect((await reserve(db, doc, 0.3)).refused_by).toBeNull()
      expect(await reserve(db, doc2, 0.3)).toEqual({ reservation: null, refused_by: 'daily' })
    })
  })

  it('refuses with monthly a call that would pass the $10 month', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 9.95, 0)
      await asServiceRole(db)
      expect(await reserve(db, doc, 0.1)).toEqual({ reservation: null, refused_by: 'monthly' })
      expect((await rows(db)).period.reserved_usd).toBe('0.000000')
    })
  })

  it('allows a reservation that reaches a cap exactly', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 0, 1.9)
      await asServiceRole(db)
      expect((await reserve(db, doc, 0.1)).refused_by).toBeNull()
    })
  })

  it('compares against app_config on every call: lowering daily_cap_usd below today’s spend refuses the next one', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 0, 1)
      await asServiceRole(db)
      expect((await reserve(db, doc, 0.01)).refused_by).toBeNull()
      await db.query('reset role')
      await db.query('update public.app_config set daily_cap_usd = 0.5')
      await asServiceRole(db)
      expect(await reserve(db, doc2, 0.01)).toEqual({ reservation: null, refused_by: 'daily' })
      // The row's cap_usd records the cap in force when it was created and decides nothing.
      expect((await rows(db)).day.cap_usd).toBe('2.00')
    })
  })

  it('takes a raised cap at once, whatever cap_usd the row recorded', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 12, 2.5)
      await db.query('update public.app_config set daily_cap_usd = 5, spend_cap_usd = 20')
      await asServiceRole(db)
      expect((await reserve(db, doc, 0.1)).refused_by).toBeNull()
    })
  })

  it('of two concurrent reservations that together pass the day, only one succeeds', async () => {
    const before = await withDb(rows)
    const a = new pg.Client({ connectionString: localDbUrl() })
    const b = new pg.Client({ connectionString: localDbUrl() })
    await a.connect()
    await b.connect()
    let reservation: string | null = null
    try {
      // Room for one estimate of 0.2 today, not two.
      await a.query('begin')
      await setSpend(a, 0, 1.7)
      await asServiceRole(a)
      const first = await reserve(a, doc, 0.2)
      reservation = first.reservation
      expect(first.refused_by).toBeNull()

      await b.query('begin')
      await asServiceRole(b)
      const second = reserve(b, doc2, 0.2)
      // b waits on the rows a holds until a commits.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await a.query('commit')
      expect(await second).toEqual({ reservation: null, refused_by: 'daily' })
      await b.query('rollback')
    } finally {
      await a.end()
      await b.end()
      // Put the shared rows back as they were.
      await withDb(async (db) => {
        if (reservation) await db.query('delete from public.ai_spend_reservations where id = $1', [reservation])
        if (before.period) {
          await db.query(`update public.ai_spend_periods set spent_usd = $1, reserved_usd = $2 where period_start = ${MONTH}`, [
            before.period.spent_usd,
            before.period.reserved_usd,
          ])
        }
        if (before.day) {
          await db.query(`update public.ai_spend_days set spent_usd = $1, reserved_usd = $2 where day = ${DAY}`, [
            before.day.spent_usd,
            before.day.reserved_usd,
          ])
        }
      })
    }
  })

  it('refuses a negative or missing estimate', async () => {
    for (const estimate of [-1, null]) {
      const code = await rolledBack(async (db) => {
        await asServiceRole(db)
        return db.query('select * from public.reserve_spend($1, $2)', [doc, estimate]).then(
          () => null,
          (e: { code: string }) => e.code,
        )
      })
      expect(code).toBe('22023')
    }
  })
})

describe('settle_spend', () => {
  let doc: string

  beforeAll(async () => {
    const user = await signUp()
    doc = (await createDocument(user, await personalWorkspaceId(user))).id
  })

  it('moves the estimate out of reserved_usd into the actual spent_usd on both rows, once', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 1, 0.5)
      await asServiceRole(db)
      const { reservation } = await reserve(db, doc, 0.1)
      await db.query('select public.settle_spend($1, $2)', [reservation, 0.0234])
      expect(await rows(db)).toEqual({
        period: { cap_usd: '10.00', spent_usd: '1.023400', reserved_usd: '0.000000' },
        day: { cap_usd: '2.00', spent_usd: '0.523400', reserved_usd: '0.000000' },
      })
      const settled = await db.query('select settled_at is not null as settled from public.ai_spend_reservations where id = $1', [
        reservation,
      ])
      expect(settled.rows).toEqual([{ settled: true }])

      // A second settle of the same reservation changes nothing.
      await db.query('select public.settle_spend($1, $2)', [reservation, 5])
      expect((await rows(db)).day.spent_usd).toBe('0.523400')
    })
  })

  it('settles a reservation with no cost, giving the whole estimate back', async () => {
    await rolledBack(async (db) => {
      await setSpend(db, 0, 0)
      await asServiceRole(db)
      const { reservation } = await reserve(db, doc, 0.4)
      await db.query('select public.settle_spend($1, 0)', [reservation])
      expect(await rows(db)).toEqual({
        period: { cap_usd: '10.00', spent_usd: '0.000000', reserved_usd: '0.000000' },
        day: { cap_usd: '2.00', spent_usd: '0.000000', reserved_usd: '0.000000' },
      })
    })
  })
})

describe('spend functions from clients', () => {
  it('refuses reserve_spend and settle_spend to a member and to anon', async () => {
    const user = await signUp()
    const doc = (await createDocument(user, await personalWorkspaceId(user))).id
    for (const client of [user.client, anonClient()]) {
      const r = await client.rpc('reserve_spend', { document_id: doc, estimate: 0.01 })
      expect(r.error?.code).toBe('42501')
      const s = await client.rpc('settle_spend', { reservation: doc, actual_cost: 0 })
      expect(s.error?.code).toBe('42501')
    }
  })
})
