import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

// profiles (ARCHITECTURE.md section 4.2): one row per auth user, made by handle_new_user(); a user
// reads their own row and those of people they share a workspace with, and updates only their own
// display_name. No client insert or delete.
describe('profiles', () => {
  let a: TestUser
  let b: TestUser
  let teammate: TestUser

  beforeAll(async () => {
    a = await signUp('Alice Example')
    b = await signUp('Bob Example')
    teammate = await signUp('Tess Mate')
    // Milestone 3 adds invitations; until then the membership is written directly, as postgres.
    const ws = await personalWorkspaceId(a)
    await withDb((db) =>
      db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
        ws,
        teammate.id,
      ]),
    )
  })

  it('gives a signed-up user a profile with their email and name', async () => {
    const { data, error } = await a.client.from('profiles').select('id, email, display_name').eq('id', a.id)
    expect(error).toBeNull()
    expect(data).toEqual([{ id: a.id, email: a.email, display_name: 'Alice Example' }])
  })

  it('shows the profiles of people who share a workspace, and no others', async () => {
    const { data, error } = await a.client.from('profiles').select('id')
    expect(error).toBeNull()
    const ids = (data ?? []).map((r) => r.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(teammate.id)
    expect(ids).not.toContain(b.id)
  })

  it('hides another user’s profile from a user who shares no workspace with them', async () => {
    const { data } = await b.client.from('profiles').select('id').eq('id', a.id)
    expect(data).toEqual([])
  })

  it('lets a user change their own display_name', async () => {
    const { data, error } = await a.client
      .from('profiles')
      .update({ display_name: 'Alice Renamed' })
      .eq('id', a.id)
      .select('display_name')
    expect(error).toBeNull()
    expect(data).toEqual([{ display_name: 'Alice Renamed' }])
  })

  it('refuses a change to another user’s display_name', async () => {
    const { data } = await teammate.client
      .from('profiles')
      .update({ display_name: 'Hijacked' })
      .eq('id', a.id)
      .select('id')
    expect(data ?? []).toEqual([])
    const row = await withDb((db) => db.query('select display_name from public.profiles where id = $1', [a.id]))
    expect(row.rows[0].display_name).not.toBe('Hijacked')
  })

  it('refuses a change to a user’s own email', async () => {
    const { error } = await a.client.from('profiles').update({ email: 'other@example.test' }).eq('id', a.id)
    expect(error?.code).toBe('42501')
  })

  it('refuses insert and delete', async () => {
    const insert = await a.client.from('profiles').insert({ id: b.id, email: 'x@example.test' })
    expect(insert.error?.code).toBe('42501')
    const del = await a.client.from('profiles').delete().eq('id', a.id)
    expect(del.error?.code).toBe('42501')
    const still = await withDb((db) => db.query('select 1 from public.profiles where id = $1', [a.id]))
    expect(still.rowCount).toBe(1)
  })

  it('shows anon nothing', async () => {
    const { data } = await anonClient().from('profiles').select('id')
    expect(data ?? []).toEqual([])
  })
})
