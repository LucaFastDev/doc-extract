import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

// workspaces (ARCHITECTURE.md section 4.2, OQ-17): members read their workspaces; only an owner
// renames (column grant on name); creation only through create_workspace() and the sign-up
// trigger; no client delete.
describe('workspaces', () => {
  let a: TestUser
  let b: TestUser
  let member: TestUser
  let wsA: string
  let wsB: string

  beforeAll(async () => {
    a = await signUp()
    b = await signUp()
    member = await signUp()
    wsA = await personalWorkspaceId(a)
    wsB = await personalWorkspaceId(b)
    await withDb((db) =>
      db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
        wsA,
        member.id,
      ]),
    )
  })

  it('gives a signed-up user exactly one workspace, of which they are the owner', async () => {
    const { data, error } = await b.client.from('workspace_members').select('workspace_id, user_id, role')
    expect(error).toBeNull()
    expect(data).toEqual([{ workspace_id: wsB, user_id: b.id, role: 'owner' }])
    const ws = await b.client.from('workspaces').select('id, plan, created_by')
    expect(ws.data).toEqual([{ id: wsB, plan: 'free', created_by: b.id }])
  })

  it('shows a user only the workspaces they are a member of', async () => {
    const { data } = await a.client.from('workspaces').select('id')
    expect((data ?? []).map((r) => r.id)).toEqual([wsA])
    const other = await a.client.from('workspaces').select('id').eq('id', wsB)
    expect(other.data).toEqual([])
  })

  it('lets an owner rename their workspace', async () => {
    const { data, error } = await a.client.from('workspaces').update({ name: 'Acme books' }).eq('id', wsA).select('name')
    expect(error).toBeNull()
    expect(data).toEqual([{ name: 'Acme books' }])
  })

  it('refuses a rename by a member who is not an owner', async () => {
    const { data } = await member.client.from('workspaces').update({ name: 'Taken over' }).eq('id', wsA).select('id')
    expect(data ?? []).toEqual([])
    const row = await withDb((db) => db.query('select name from public.workspaces where id = $1', [wsA]))
    expect(row.rows[0].name).not.toBe('Taken over')
  })

  it('refuses a rename of another user’s workspace', async () => {
    const { data } = await a.client.from('workspaces').update({ name: 'Taken over' }).eq('id', wsB).select('id')
    expect(data ?? []).toEqual([])
    const row = await withDb((db) => db.query('select name from public.workspaces where id = $1', [wsB]))
    expect(row.rows[0].name).not.toBe('Taken over')
  })

  it('refuses a change to the plan or the Stripe columns, even by the owner', async () => {
    const plan = await a.client.from('workspaces').update({ plan: 'pro' }).eq('id', wsA)
    expect(plan.error?.code).toBe('42501')
    const stripe = await a.client.from('workspaces').update({ stripe_customer_id: 'cus_x' }).eq('id', wsA)
    expect(stripe.error?.code).toBe('42501')
  })

  it('refuses insert and delete', async () => {
    const insert = await a.client.from('workspaces').insert({ name: 'Direct' })
    expect(insert.error?.code).toBe('42501')
    const del = await a.client.from('workspaces').delete().eq('id', wsA)
    expect(del.error?.code).toBe('42501')
    const still = await withDb((db) => db.query('select 1 from public.workspaces where id = $1', [wsA]))
    expect(still.rowCount).toBe(1)
  })

  it('shows anon nothing', async () => {
    const { data } = await anonClient().from('workspaces').select('id')
    expect(data ?? []).toEqual([])
  })
})

describe('create_workspace', () => {
  it('creates a workspace with the caller as its only member and owner', async () => {
    const user = await signUp()
    const { data: id, error } = await user.client.rpc('create_workspace', { name: '  Side project  ' })
    expect(error).toBeNull()
    const ws = await user.client.from('workspaces').select('id, name, created_by').eq('id', id)
    expect(ws.data).toEqual([{ id, name: 'Side project', created_by: user.id }])
    const members = await user.client.from('workspace_members').select('user_id, role').eq('workspace_id', id)
    expect(members.data).toEqual([{ user_id: user.id, role: 'owner' }])
  })

  it('refuses a blank name', async () => {
    const user = await signUp()
    const { error } = await user.client.rpc('create_workspace', { name: '   ' })
    expect(error).not.toBeNull()
    const { data } = await user.client.from('workspaces').select('id')
    expect(data).toHaveLength(1)
  })

  it('refuses anon', async () => {
    const { error } = await anonClient().rpc('create_workspace', { name: 'Signed out' })
    expect(error).not.toBeNull()
    const rows = await withDb((db) => db.query("select 1 from public.workspaces where name = 'Signed out'"))
    expect(rows.rowCount).toBe(0)
  })
})
