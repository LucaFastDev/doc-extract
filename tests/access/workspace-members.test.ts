import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { anonClient, personalWorkspaceId, signUp, type TestUser } from './users'

// workspace_members (ARCHITECTURE.md section 4.2): members read their workspaces' memberships; no
// client writes at all (invitations and role changes are RPCs in milestone 3).
describe('workspace_members', () => {
  let a: TestUser
  let b: TestUser
  let wsA: string
  let wsB: string

  beforeAll(async () => {
    a = await signUp()
    b = await signUp()
    wsA = await personalWorkspaceId(a)
    wsB = await personalWorkspaceId(b)
  })

  it('shows a user the memberships of their workspaces only', async () => {
    const { data, error } = await a.client.from('workspace_members').select('workspace_id, user_id')
    expect(error).toBeNull()
    expect(data).toEqual([{ workspace_id: wsA, user_id: a.id }])
    const other = await a.client.from('workspace_members').select('user_id').eq('workspace_id', wsB)
    expect(other.data).toEqual([])
  })

  it('refuses a user joining another workspace', async () => {
    const { error } = await a.client.from('workspace_members').insert({ workspace_id: wsB, user_id: a.id, role: 'owner' })
    expect(error?.code).toBe('42501')
    const rows = await withDb((db) =>
      db.query('select 1 from public.workspace_members where workspace_id = $1 and user_id = $2', [wsB, a.id]),
    )
    expect(rows.rowCount).toBe(0)
  })

  it('refuses update and delete, of their own membership or another’s', async () => {
    const promote = await a.client.from('workspace_members').update({ role: 'member' }).eq('workspace_id', wsA)
    expect(promote.error?.code).toBe('42501')
    const leave = await a.client.from('workspace_members').delete().eq('workspace_id', wsA)
    expect(leave.error?.code).toBe('42501')
    const kick = await a.client.from('workspace_members').delete().eq('workspace_id', wsB)
    expect(kick.error?.code).toBe('42501')
    const rows = await withDb((db) =>
      db.query('select role from public.workspace_members where workspace_id = any($1) order by role', [[wsA, wsB]]),
    )
    expect(rows.rows).toEqual([{ role: 'owner' }, { role: 'owner' }])
  })

  it('shows anon nothing', async () => {
    const { data } = await anonClient().from('workspace_members').select('user_id')
    expect(data ?? []).toEqual([])
  })
})

describe('is_member and is_owner', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await withDb((db) =>
      db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
        ws,
        member.id,
      ]),
    )
  })

  it('answer for the caller only', async () => {
    const results = await Promise.all(
      [owner, member, stranger].flatMap((u) => [
        u.client.rpc('is_member', { ws }).then((r) => r.data),
        u.client.rpc('is_owner', { ws }).then((r) => r.data),
      ]),
    )
    expect(results).toEqual([true, true, true, false, false, false])
  })

  it('refuse anon', async () => {
    const { error } = await anonClient().rpc('is_member', { ws })
    expect(error).not.toBeNull()
  })
})
