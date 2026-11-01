import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { addMember, adminClient, anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

// stripe_events (ARCHITECTURE.md section 4.2, Lead ruling 3 on #50): RLS on, no client grants; only
// the webhook route handler's service-role client reads and writes it. And the plan and Stripe
// columns of workspaces, which only that handler writes.
describe('stripe_events', () => {
  const seen = `evt_access_${randomUUID()}`
  const forged = `evt_access_${randomUUID()}`
  let user: TestUser

  beforeAll(async () => {
    user = await signUp()
    const { error } = await adminClient().from('stripe_events').insert({ id: seen, type: 'checkout.session.completed' })
    expect(error).toBeNull()
  })

  it('has row level security on, the columns section 4.2 lists, and no policy', async () => {
    await withDb(async (db) => {
      const rls = await db.query("select relrowsecurity from pg_class where oid = 'public.stripe_events'::regclass")
      expect(rls.rows[0].relrowsecurity).toBe(true)
      const columns = await db.query(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'stripe_events' order by ordinal_position",
      )
      expect(columns.rows.map((c) => c.column_name)).toEqual(['id', 'type', 'received_at', 'processed_at'])
      const policies = await db.query("select 1 from pg_policies where schemaname = 'public' and tablename = 'stripe_events'")
      expect(policies.rowCount).toBe(0)
    })
  })

  it.each(['anon', 'authenticated'])('gives %s no privilege on it', async (role) => {
    await withDb(async (db) => {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        const { rows } = await db.query('select has_table_privilege($1, $2, $3) as allowed', [role, 'public.stripe_events', privilege])
        expect(rows[0].allowed).toBe(false)
      }
    })
  })

  it('refuses anon and a signed-in user reading it', async () => {
    for (const client of [anonClient(), user.client]) {
      const { data, error } = await client.from('stripe_events').select('id')
      expect(error?.code).toBe('42501')
      expect(data).toBeNull()
    }
  })

  it('refuses anon and a signed-in user writing it, and nothing changes', async () => {
    for (const client of [anonClient(), user.client]) {
      const attempts = [
        client.from('stripe_events').insert({ id: forged, type: 'x' }),
        client.from('stripe_events').update({ processed_at: new Date().toISOString() }).eq('id', seen),
        client.from('stripe_events').delete().eq('id', seen),
      ]
      for (const attempt of attempts) {
        expect((await attempt).error?.code).toBe('42501')
      }
    }
    const { rows } = await withDb((db) =>
      db.query('select id, processed_at from public.stripe_events where id = any($1)', [[seen, forged]]),
    )
    expect(rows).toEqual([{ id: seen, processed_at: null }])
  })
})

describe('the plan and Stripe columns of workspaces', () => {
  let owner: TestUser
  let member: TestUser
  let ws: string

  const COLUMNS = {
    plan: 'pro',
    stripe_customer_id: 'cus_forged',
    stripe_subscription_id: 'sub_forged',
    plan_period_end: '2099-01-01T00:00:00Z',
    plan_cancel_at_period_end: true,
  }

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
  })

  it.each(Object.entries(COLUMNS))('refuses the owner and a member changing %s', async (column, value) => {
    for (const user of [owner, member]) {
      const { error } = await user.client.from('workspaces').update({ [column]: value }).eq('id', ws)
      expect(error?.code).toBe('42501')
    }
    const { rows } = await withDb((db) =>
      db.query(
        'select plan, stripe_customer_id, stripe_subscription_id, plan_period_end, plan_cancel_at_period_end from public.workspaces where id = $1',
        [ws],
      ),
    )
    expect(rows).toEqual([
      { plan: 'free', stripe_customer_id: null, stripe_subscription_id: null, plan_period_end: null, plan_cancel_at_period_end: false },
    ])
  })

  it('lets a member read them, so the billing page can show the plan', async () => {
    const { data, error } = await member.client
      .from('workspaces')
      .select('plan, plan_period_end, plan_cancel_at_period_end')
      .eq('id', ws)
    expect(error).toBeNull()
    expect(data).toEqual([{ plan: 'free', plan_period_end: null, plan_cancel_at_period_end: false }])
  })
})
