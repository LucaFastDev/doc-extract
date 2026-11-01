import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { adminClient, anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

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

  it('refuses a display_name of 101 characters through the API, and takes 100 and null', async () => {
    const user = await signUp('Short Name')
    const over = await user.client.from('profiles').update({ display_name: 'd'.repeat(101) }).eq('id', user.id).select('id')
    expect(over.error?.code).toBe('23514')
    const row = await withDb((db) => db.query('select display_name from public.profiles where id = $1', [user.id]))
    expect(row.rows[0].display_name).toBe('Short Name')

    for (const name of ['d'.repeat(100), '😀'.repeat(100), null]) {
      const { data, error } = await user.client.from('profiles').update({ display_name: name }).eq('id', user.id).select('display_name')
      expect(error).toBeNull()
      expect(data).toEqual([{ display_name: name }])
    }
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

// Issue #69 criterion 3: the trigger cuts a long name rather than refusing it, so a sign-up never
// fails because of one.
describe('handle_new_user with a name over 100 characters', () => {
  async function displayNameAfterSignUp(metadata: Record<string, string>) {
    const { data, error } = await adminClient().auth.admin.createUser({
      email: `access-${randomUUID()}@example.test`,
      email_confirm: true,
      user_metadata: metadata,
    })
    expect(error).toBeNull()
    const row = await withDb((db) => db.query('select display_name from public.profiles where id = $1', [data.user!.id]))
    return row.rows[0].display_name as string
  }

  it('signs the user up, with a profile and personal workspace, and cuts full_name to 100', async () => {
    const user = await signUp('f'.repeat(150))
    const { data, error } = await user.client.from('profiles').select('display_name').eq('id', user.id)
    expect(error).toBeNull()
    expect(data).toEqual([{ display_name: 'f'.repeat(100) }])
    expect(await personalWorkspaceId(user)).toEqual(expect.any(String))
  })

  it('cuts the name metadata to 100', async () => {
    expect(await displayNameAfterSignUp({ name: 'g'.repeat(150) })).toBe('g'.repeat(100))
  })

  it('trims first, then cuts, so the spaces do not use up the 100', async () => {
    expect(await displayNameAfterSignUp({ full_name: `   ${'h'.repeat(150)}   ` })).toBe('h'.repeat(100))
    expect(await displayNameAfterSignUp({ full_name: `   ${'i'.repeat(100)}   ` })).toBe('i'.repeat(100))
  })

  it('counts characters, not bytes', async () => {
    expect(await displayNameAfterSignUp({ full_name: '😀'.repeat(150) })).toBe('😀'.repeat(100))
  })
})
