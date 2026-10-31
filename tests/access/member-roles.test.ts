import { describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { addMember, anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

// remove_member and set_member_role (ARCHITECTURE.md section 4.1, PRD US-8.2 AC-4 to AC-6, OQ-20):
// only an owner removes members and changes roles, and a workspace always keeps one owner.

async function roles(ws: string): Promise<Record<string, string>> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ user_id: string; role: string }>(
      'select user_id, role from public.workspace_members where workspace_id = $1',
      [ws],
    )
    return Object.fromEntries(rows.map((r) => [r.user_id, r.role]))
  })
}

/** A workspace with one owner, one member, and a stranger who belongs to it not at all. */
async function workspace() {
  const owner = await signUp()
  const member = await signUp()
  const stranger = await signUp()
  const ws = await personalWorkspaceId(owner)
  await addMember(ws, member, 'member')
  return { owner, member, stranger, ws }
}

function callers(...users: TestUser[]) {
  return [...users.map((u) => u.client), anonClient()]
}

describe('remove_member', () => {
  it('lets an owner remove a member', async () => {
    const { owner, member, ws } = await workspace()
    const { error } = await owner.client.rpc('remove_member', { ws, member: member.id })
    expect(error).toBeNull()
    expect(await roles(ws)).toEqual({ [owner.id]: 'owner' })
  })

  it('refuses a member, a non-member and anon, and removes no one', async () => {
    const { owner, member, stranger, ws } = await workspace()
    const before = await roles(ws)
    for (const client of callers(member, stranger)) {
      for (const target of [owner.id, member.id]) {
        const { error } = await client.rpc('remove_member', { ws, member: target })
        expect(error?.code).toBe('42501')
      }
    }
    expect(await roles(ws)).toEqual(before)
  })

  it('refuses removing the last owner', async () => {
    const { owner, member, ws } = await workspace()
    const { error } = await owner.client.rpc('remove_member', { ws, member: owner.id })
    expect(error?.code).toBe('23514')
    expect(await roles(ws)).toEqual({ [owner.id]: 'owner', [member.id]: 'member' })
  })

  it('lets an owner remove another owner while one remains', async () => {
    const { owner, member, ws } = await workspace()
    const second = await signUp()
    await addMember(ws, second, 'owner')
    expect((await owner.client.rpc('remove_member', { ws, member: second.id })).error).toBeNull()
    expect(await roles(ws)).toEqual({ [owner.id]: 'owner', [member.id]: 'member' })
  })

  it('says so when the user is not a member', async () => {
    const { owner, stranger, ws } = await workspace()
    const { error } = await owner.client.rpc('remove_member', { ws, member: stranger.id })
    expect(error?.code).toBe('P0002')
  })
})

describe('set_member_role', () => {
  it('lets an owner make a member an owner, and an owner a member again', async () => {
    const { owner, member, ws } = await workspace()
    expect((await owner.client.rpc('set_member_role', { ws, member: member.id, role: 'owner' })).error).toBeNull()
    expect(await roles(ws)).toEqual({ [owner.id]: 'owner', [member.id]: 'owner' })
    expect((await owner.client.rpc('set_member_role', { ws, member: member.id, role: 'member' })).error).toBeNull()
    expect(await roles(ws)).toEqual({ [owner.id]: 'owner', [member.id]: 'member' })
  })

  it('refuses a member, a non-member and anon, and changes no role', async () => {
    const { owner, member, stranger, ws } = await workspace()
    const before = await roles(ws)
    for (const client of callers(member, stranger)) {
      for (const [target, role] of [
        [member.id, 'owner'],
        [owner.id, 'member'],
      ]) {
        const { error } = await client.rpc('set_member_role', { ws, member: target, role })
        expect(error?.code).toBe('42501')
      }
    }
    expect(await roles(ws)).toEqual(before)
  })

  it('refuses demoting the last owner', async () => {
    const { owner, member, ws } = await workspace()
    const { error } = await owner.client.rpc('set_member_role', { ws, member: owner.id, role: 'member' })
    expect(error?.code).toBe('23514')
    expect(await roles(ws)).toEqual({ [owner.id]: 'owner', [member.id]: 'member' })
  })

  it('lets an owner step down while another owner remains', async () => {
    const { owner, member, ws } = await workspace()
    await owner.client.rpc('set_member_role', { ws, member: member.id, role: 'owner' })
    expect((await owner.client.rpc('set_member_role', { ws, member: owner.id, role: 'member' })).error).toBeNull()
    expect(await roles(ws)).toEqual({ [owner.id]: 'member', [member.id]: 'owner' })
  })

  it('refuses a role other than owner or member', async () => {
    const { owner, member, ws } = await workspace()
    for (const role of ['admin', null]) {
      const { error } = await owner.client.rpc('set_member_role', { ws, member: member.id, role })
      expect(error?.code).toBe('22023')
    }
    expect(await roles(ws)).toEqual({ [owner.id]: 'owner', [member.id]: 'member' })
  })

  it('says so when the user is not a member', async () => {
    const { owner, stranger, ws } = await workspace()
    const { error } = await owner.client.rpc('set_member_role', { ws, member: stranger.id, role: 'owner' })
    expect(error?.code).toBe('P0002')
    expect(await roles(ws)).not.toHaveProperty(stranger.id)
  })
})
