import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { addMember, adminClient, anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// page_usage, account_page_usage, reserve_pages and get_page_allowance (ARCHITECTURE.md sections
// 4.1, 4.2 and 7, PRD US-1.1 AC-6, OQ-2, OQ-3): pages per workspace per UTC month and per account
// for its lifetime, written only by reserve_pages with the service role, which refuses a
// reservation over either limit and then counts nothing.

const MONTH = "date_trunc('month', now() at time zone 'utc')::date"

async function setWorkspaceUsage(ws: string, pages: number) {
  await withDb((db) =>
    db.query(
      `insert into public.page_usage (workspace_id, period_start, pages_used) values ($1, ${MONTH}, $2)
       on conflict (workspace_id, period_start) do update set pages_used = excluded.pages_used`,
      [ws, pages],
    ),
  )
}

async function setAccountUsage(user: TestUser, pages: number) {
  await withDb((db) =>
    db.query(
      `insert into public.account_page_usage (user_id, pages_used) values ($1, $2)
       on conflict (user_id) do update set pages_used = excluded.pages_used`,
      [user.id, pages],
    ),
  )
}

async function usage(ws: string, user: TestUser) {
  return withDb(async (db) => {
    const w = await db.query<{ pages_used: number }>(
      `select pages_used from public.page_usage where workspace_id = $1 and period_start = ${MONTH}`,
      [ws],
    )
    const a = await db.query<{ pages_used: number }>('select pages_used from public.account_page_usage where user_id = $1', [
      user.id,
    ])
    return { workspace: w.rows[0]?.pages_used ?? 0, account: a.rows[0]?.pages_used ?? 0 }
  })
}

/** A document as submit-document leaves it before it reserves: its pages counted on the row. */
async function documentWithPages(user: TestUser, ws: string, pages: number): Promise<string> {
  const { id } = await createDocument(user, ws)
  await withDb((db) => db.query('update public.documents set page_count = $2 where id = $1', [id, pages]))
  return id
}

async function pagesReserved(id: string): Promise<boolean> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ pages_reserved: boolean }>('select pages_reserved from public.documents where id = $1', [
      id,
    ])
    return rows[0].pages_reserved
  })
}

describe('reserve_pages', () => {
  it('counts the pages against the workspace month and the uploader’s lifetime', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    const doc = await documentWithPages(user, ws, 3)

    const { data, error } = await adminClient().rpc('reserve_pages', { document_id: doc })
    expect(error).toBeNull()
    expect(data).toBe(true)
    expect(await usage(ws, user)).toEqual({ workspace: 3, account: 3 })
    expect(await pagesReserved(doc)).toBe(true)

    // A second call for the same document counts nothing more.
    expect((await adminClient().rpc('reserve_pages', { document_id: doc })).data).toBe(true)
    expect(await usage(ws, user)).toEqual({ workspace: 3, account: 3 })
  })

  it('allows a reservation that reaches the account cap of 10 exactly', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    await setAccountUsage(user, 8)
    const doc = await documentWithPages(user, ws, 2)
    expect((await adminClient().rpc('reserve_pages', { document_id: doc })).data).toBe(true)
    expect(await usage(ws, user)).toEqual({ workspace: 2, account: 10 })
  })

  it('refuses a reservation over the account lifetime cap of 10 pages, and counts nothing', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    await setAccountUsage(user, 9)
    const doc = await documentWithPages(user, ws, 2)

    const { data, error } = await adminClient().rpc('reserve_pages', { document_id: doc })
    expect(error).toBeNull()
    expect(data).toBe(false)
    expect(await usage(ws, user)).toEqual({ workspace: 0, account: 9 })
    expect(await pagesReserved(doc)).toBe(false)
  })

  it('refuses a reservation over the workspace’s monthly allowance, and counts nothing', async () => {
    const owner = await signUp()
    const uploader = await signUp()
    const ws = await personalWorkspaceId(owner)
    await addMember(ws, uploader, 'member')
    await setWorkspaceUsage(ws, 19)
    const doc = await documentWithPages(uploader, ws, 2)

    const { data, error } = await adminClient().rpc('reserve_pages', { document_id: doc })
    expect(error).toBeNull()
    expect(data).toBe(false)
    expect(await usage(ws, uploader)).toEqual({ workspace: 19, account: 0 })
    expect(await pagesReserved(doc)).toBe(false)
  })

  it('uses the Pro allowance of 500 for a Pro workspace', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    await withDb((db) => db.query("update public.workspaces set plan = 'pro' where id = $1", [ws]))
    await setWorkspaceUsage(ws, 495)
    expect((await adminClient().rpc('reserve_pages', { document_id: await documentWithPages(user, ws, 5) })).data).toBe(true)
    expect(await usage(ws, user)).toEqual({ workspace: 500, account: 5 })
    expect((await adminClient().rpc('reserve_pages', { document_id: await documentWithPages(user, ws, 1) })).data).toBe(
      false,
    )
    expect(await usage(ws, user)).toEqual({ workspace: 500, account: 5 })
  })

  it('refuses every client, a member included, and counts nothing', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    const doc = await documentWithPages(user, ws, 1)
    for (const client of [user.client, anonClient()]) {
      const { error } = await client.rpc('reserve_pages', { document_id: doc })
      expect(error?.code).toBe('42501')
    }
    expect(await usage(ws, user)).toEqual({ workspace: 0, account: 0 })
  })
})

describe('get_page_allowance', () => {
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
    await setWorkspaceUsage(ws, 7)
    await setAccountUsage(member, 4)
  })

  it('tells a member the workspace’s pages this month and their own account’s', async () => {
    const { data, error } = await member.client.rpc('get_page_allowance', { ws }).single()
    expect(error).toBeNull()
    expect(data).toEqual({ workspace_used: 7, workspace_limit: 20, account_used: 4, account_cap: 10 })
    const own = await owner.client.rpc('get_page_allowance', { ws }).single()
    expect(own.data).toEqual({ workspace_used: 7, workspace_limit: 20, account_used: 0, account_cap: 10 })
  })

  it('refuses a non-member and anon', async () => {
    for (const client of [stranger.client, anonClient()]) {
      const { data, error } = await client.rpc('get_page_allowance', { ws })
      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    }
  })
})

describe('page_usage and account_page_usage', () => {
  let ownerA: TestUser
  let memberA: TestUser
  let ownerB: TestUser
  let wsA: string

  beforeAll(async () => {
    ownerA = await signUp()
    memberA = await signUp()
    ownerB = await signUp()
    wsA = await personalWorkspaceId(ownerA)
    await addMember(wsA, memberA, 'member')
    await setWorkspaceUsage(wsA, 5)
    await setWorkspaceUsage(await personalWorkspaceId(ownerB), 6)
    await setAccountUsage(ownerA, 3)
    await setAccountUsage(memberA, 2)
  })

  it('shows members their workspace’s usage only, and anon none', async () => {
    for (const user of [ownerA, memberA]) {
      const { data, error } = await user.client.from('page_usage').select('workspace_id, pages_used')
      expect(error).toBeNull()
      expect(data).toEqual([{ workspace_id: wsA, pages_used: 5 }])
    }
    const anon = await anonClient().from('page_usage').select('workspace_id')
    expect(anon.data ?? []).toEqual([])
  })

  it('shows each user their own account usage only, and anon none', async () => {
    const { data, error } = await memberA.client.from('account_page_usage').select('user_id, pages_used')
    expect(error).toBeNull()
    expect(data).toEqual([{ user_id: memberA.id, pages_used: 2 }])
    const anon = await anonClient().from('account_page_usage').select('user_id')
    expect(anon.data ?? []).toEqual([])
  })

  it('lets no client insert, update or delete either', async () => {
    const attempts = [
      ownerA.client.from('page_usage').insert({ workspace_id: wsA, period_start: '2001-01-01', pages_used: 0 }),
      ownerA.client.from('page_usage').update({ pages_used: 0 }).eq('workspace_id', wsA),
      ownerA.client.from('page_usage').delete().eq('workspace_id', wsA),
      ownerA.client.from('account_page_usage').insert({ user_id: ownerB.id, pages_used: 0 }),
      ownerA.client.from('account_page_usage').update({ pages_used: 0 }).eq('user_id', ownerA.id),
      ownerA.client.from('account_page_usage').delete().eq('user_id', ownerA.id),
      anonClient().from('page_usage').update({ pages_used: 0 }).eq('workspace_id', wsA),
      anonClient().from('account_page_usage').delete().eq('user_id', ownerA.id),
    ]
    for (const attempt of attempts) {
      expect((await attempt).error?.code).toBe('42501')
    }
    expect(await usage(wsA, ownerA)).toEqual({ workspace: 5, account: 3 })
    expect((await usage(wsA, memberA)).account).toBe(2)
  })
})
