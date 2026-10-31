import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { addMember, anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

// workspace_invites, create_invite and accept_invite (ARCHITECTURE.md sections 4.1 and 4.2, PRD
// US-8.2, OQ-18 to OQ-20): only an owner invites, sees and revokes invitations; the token is never
// stored; an invitation is accepted once, by the invited address, within 7 days.

interface InviteRow {
  email: string
  role: string
  token_hash: string
  invited_by: string | null
  accepted_at: Date | null
  revoked_at: Date | null
  lifetime: string
  age_seconds: number
}

function sha256(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

async function inviteRows(ws: string): Promise<InviteRow[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<InviteRow>(
      `select email, role, token_hash, invited_by, accepted_at, revoked_at,
              (expires_at - created_at)::text as lifetime,
              extract(epoch from now() - created_at)::float as age_seconds
       from public.workspace_invites where workspace_id = $1 order by created_at`,
      [ws],
    )
    return rows
  })
}

async function roleIn(ws: string, user: TestUser): Promise<string | null> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ role: string }>(
      'select role from public.workspace_members where workspace_id = $1 and user_id = $2',
      [ws, user.id],
    )
    return rows[0]?.role ?? null
  })
}

async function invite(owner: TestUser, ws: string, email: string, role = 'member'): Promise<string> {
  const { data, error } = await owner.client.rpc('create_invite', { ws, email, role })
  if (error) throw error
  return data as string
}

describe('create_invite', () => {
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

  it('lets an owner invite an address, storing only the token’s SHA-256, expiring after 7 days', async () => {
    const { data: token, error } = await owner.client.rpc('create_invite', {
      ws,
      email: '  Someone@Example.TEST ',
      role: 'member',
    })
    expect(error).toBeNull()
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    const rows = await inviteRows(ws)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email: 'someone@example.test',
      role: 'member',
      token_hash: sha256(token as string),
      invited_by: owner.id,
      accepted_at: null,
      revoked_at: null,
      lifetime: '7 days',
    })
    expect(rows[0].age_seconds).toBeLessThan(60)
    const stored = await withDb((db) =>
      db.query("select 1 from public.workspace_invites where row_to_json(workspace_invites)::text like '%' || $1 || '%'", [
        token,
      ]),
    )
    expect(stored.rowCount).toBe(0)
  })

  it('lets an owner invite as owner, with a new token each time', async () => {
    const first = await invite(owner, ws, 'co-owner@example.test', 'owner')
    const second = await invite(owner, ws, 'co-owner@example.test', 'owner')
    expect(first).not.toBe(second)
    const rows = (await inviteRows(ws)).filter((r) => r.email === 'co-owner@example.test')
    expect(rows.map((r) => r.role)).toEqual(['owner', 'owner'])
  })

  it('refuses a member, a non-member and anon, and stores nothing', async () => {
    const before = (await inviteRows(ws)).length
    for (const client of [member.client, stranger.client, anonClient()]) {
      const { data, error } = await client.rpc('create_invite', { ws, email: 'x@example.test', role: 'member' })
      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    }
    expect(await inviteRows(ws)).toHaveLength(before)
  })

  it('refuses a role other than owner or member, and an address that is not an email', async () => {
    const before = (await inviteRows(ws)).length
    for (const [email, role] of [
      ['x@example.test', 'admin'],
      ['x@example.test', null],
      ['not-an-email', 'member'],
      ['', 'member'],
    ]) {
      const { error } = await owner.client.rpc('create_invite', { ws, email, role })
      expect(error?.code).toBe('22023')
    }
    expect(await inviteRows(ws)).toHaveLength(before)
  })
})

describe('workspace_invites', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let invitee: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    invitee = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
    await invite(owner, ws, invitee.email)
  })

  it('shows an owner their workspace’s invitations', async () => {
    const { data, error } = await owner.client.from('workspace_invites').select('workspace_id, email, role')
    expect(error).toBeNull()
    expect(data).toEqual([{ workspace_id: ws, email: invitee.email, role: 'member' }])
  })

  it('shows a member, a non-member, the invitee and anon nothing', async () => {
    for (const client of [member.client, stranger.client, invitee.client, anonClient()]) {
      const { data } = await client.from('workspace_invites').select('id')
      expect(data ?? []).toEqual([])
    }
  })

  it('has no client insert or delete, not even for an owner', async () => {
    const insert = await owner.client.from('workspace_invites').insert({
      workspace_id: ws,
      email: 'direct@example.test',
      role: 'owner',
      token_hash: sha256('chosen'),
      expires_at: new Date(Date.now() + 365 * 86400_000).toISOString(),
    })
    expect(insert.error?.code).toBe('42501')
    const remove = await owner.client.from('workspace_invites').delete().eq('workspace_id', ws)
    expect(remove.error?.code).toBe('42501')
    expect((await inviteRows(ws)).map((r) => r.email)).toEqual([invitee.email])
  })

  it('lets only an owner revoke a pending invitation, and change nothing else', async () => {
    const otherWs = await personalWorkspaceId(stranger)
    await invite(stranger, otherWs, 'other@example.test')

    for (const client of [member.client, invitee.client, anonClient()]) {
      const { data } = await client
        .from('workspace_invites')
        .update({ revoked_at: new Date().toISOString() })
        .eq('workspace_id', ws)
        .select('id')
      expect(data ?? []).toEqual([])
    }
    // An owner of one workspace cannot revoke another workspace's invitation.
    const across = await owner.client
      .from('workspace_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('workspace_id', otherWs)
      .select('id')
    expect(across.data).toEqual([])
    expect((await inviteRows(otherWs))[0].revoked_at).toBeNull()

    const other = await owner.client.from('workspace_invites').update({ role: 'owner' }).eq('workspace_id', ws)
    expect(other.error?.code).toBe('42501')
    const expiry = await owner.client
      .from('workspace_invites')
      .update({ expires_at: new Date(Date.now() + 365 * 86400_000).toISOString() })
      .eq('workspace_id', ws)
    expect(expiry.error?.code).toBe('42501')
    expect((await inviteRows(ws))[0]).toMatchObject({ role: 'member', revoked_at: null, lifetime: '7 days' })

    const revoke = await owner.client
      .from('workspace_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('workspace_id', ws)
      .select('id')
    expect(revoke.error).toBeNull()
    expect(revoke.data).toHaveLength(1)
    expect((await inviteRows(ws))[0].revoked_at).not.toBeNull()
  })

  it('does not let an owner bring a revoked or accepted invitation back', async () => {
    const token = await invite(owner, ws, stranger.email)
    expect((await stranger.client.rpc('accept_invite', { token })).error).toBeNull()

    const reopen = await owner.client
      .from('workspace_invites')
      .update({ revoked_at: null })
      .eq('workspace_id', ws)
      .select('id')
    expect(reopen.data).toEqual([])
    const revokeAccepted = await owner.client
      .from('workspace_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('email', stranger.email)
      .select('id')
    expect(revokeAccepted.data).toEqual([])
    const rows = await inviteRows(ws)
    expect(rows.find((r) => r.email === invitee.email)?.revoked_at).not.toBeNull()
    expect(rows.find((r) => r.email === stranger.email)).toMatchObject({ revoked_at: null })
  })
})

describe('accept_invite', () => {
  let owner: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    ws = await personalWorkspaceId(owner)
  })

  it('makes the user signed in with the invited address a member with the invited role, once', async () => {
    const invitee = await signUp()
    const token = await invite(owner, ws, invitee.email.toUpperCase(), 'owner')

    const { data, error } = await invitee.client.rpc('accept_invite', { token })
    expect(error).toBeNull()
    expect(data).toBe(ws)
    expect(await roleIn(ws, invitee)).toBe('owner')
    const row = (await inviteRows(ws)).find((r) => r.email === invitee.email)
    expect(row?.accepted_at).not.toBeNull()

    const again = await invitee.client.rpc('accept_invite', { token })
    expect(again.error?.code).toBe('P0002')
    expect(await roleIn(ws, invitee)).toBe('owner')
  })

  it('gives the member role for a member invitation', async () => {
    const invitee = await signUp()
    const token = await invite(owner, ws, invitee.email, 'member')
    expect((await invitee.client.rpc('accept_invite', { token })).error).toBeNull()
    expect(await roleIn(ws, invitee)).toBe('member')
  })

  it('refuses anyone signed in with another address, and changes nothing', async () => {
    const invitee = await signUp()
    const someoneElse = await signUp()
    const token = await invite(owner, ws, invitee.email)

    const { data, error } = await someoneElse.client.rpc('accept_invite', { token })
    expect(data).toBeNull()
    expect(error?.code).toBe('42501')
    expect(await roleIn(ws, someoneElse)).toBeNull()
    expect((await inviteRows(ws)).find((r) => r.email === invitee.email)?.accepted_at).toBeNull()

    // The invitation is still there for the right person.
    expect((await invitee.client.rpc('accept_invite', { token })).error).toBeNull()
  })

  it('refuses anon', async () => {
    const invitee = await signUp()
    const token = await invite(owner, ws, invitee.email)
    const { error } = await anonClient().rpc('accept_invite', { token })
    expect(error?.code).toBe('42501')
    expect((await inviteRows(ws)).find((r) => r.email === invitee.email)?.accepted_at).toBeNull()
  })

  it('refuses an expired invitation', async () => {
    const invitee = await signUp()
    const token = await invite(owner, ws, invitee.email)
    await withDb((db) =>
      db.query(
        "update public.workspace_invites set created_at = now() - interval '7 days 1 second', expires_at = now() - interval '1 second' where token_hash = $1",
        [sha256(token)],
      ),
    )
    const { error } = await invitee.client.rpc('accept_invite', { token })
    expect(error?.code).toBe('P0002')
    expect(await roleIn(ws, invitee)).toBeNull()
  })

  it('refuses a revoked invitation', async () => {
    const invitee = await signUp()
    const token = await invite(owner, ws, invitee.email)
    await owner.client
      .from('workspace_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('email', invitee.email)
    const { error } = await invitee.client.rpc('accept_invite', { token })
    expect(error?.code).toBe('P0002')
    expect(await roleIn(ws, invitee)).toBeNull()
  })

  it('refuses a token that was never issued', async () => {
    const invitee = await signUp()
    const { error } = await invitee.client.rpc('accept_invite', { token: 'f'.repeat(64) })
    expect(error?.code).toBe('P0002')
  })

  it('refuses someone who is already a member, leaving their role and the invitation as they were', async () => {
    const member = await signUp()
    await addMember(ws, member, 'member')
    const token = await invite(owner, ws, member.email, 'owner')
    const { error } = await member.client.rpc('accept_invite', { token })
    expect(error?.code).toBe('23505')
    expect(await roleIn(ws, member)).toBe('member')
    expect((await inviteRows(ws)).find((r) => r.email === member.email)?.accepted_at).toBeNull()
  })
})
