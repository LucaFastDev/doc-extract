import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let user: { id: string } | null = null
const rpc = vi.fn()
const update = vi.fn()

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`)
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc,
    from: () => ({ update: (values: unknown) => ({ eq: () => ({ select: () => update(values) }) }) }),
  }),
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-request-path': '/members' }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { createInvite, removeMember, revokeInvite, setMemberRole } = await import('./actions')

function form(fields: Record<string, string>) {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

const inviteForm = () => form({ workspace: 'ws-1', email: ' Someone@Example.test ', role: 'member' })

beforeEach(() => {
  user = { id: 'u1' }
  rpc.mockReset()
  update.mockReset()
  vi.stubEnv('SITE_URL', 'https://site.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('members actions after the session has ended', () => {
  it.each([
    ['invite', () => createInvite({}, inviteForm())],
    ['revoke', () => revokeInvite('inv-1')],
    ['remove', () => removeMember('ws-1', 'u2')],
    ['change role', () => setMemberRole('ws-1', 'u2', 'owner')],
  ])('%s sends the visitor to sign-in with the page as next, and changes nothing', async (_name, run) => {
    user = null
    const error = await run().then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Redirected)
    const url = new URL((error as Redirected).to, 'http://site.test')
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('next')).toBe('/members')
    expect(rpc).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('createInvite', () => {
  it('returns <site>/invite/<token> for the token create_invite gives back', async () => {
    rpc.mockResolvedValue({ data: 'abc123', error: null })
    const state = await createInvite({}, inviteForm())
    expect(rpc).toHaveBeenCalledWith('create_invite', { ws: 'ws-1', email: 'Someone@Example.test', role: 'member' })
    expect(state).toEqual({ link: 'https://site.test/invite/abc123', email: 'someone@example.test' })
  })

  it('asks for an address and a role before calling the database', async () => {
    expect(await createInvite({}, form({ workspace: 'ws-1', email: ' ', role: 'member' }))).toEqual({
      error: 'Enter an email address.',
    })
    expect(await createInvite({}, form({ workspace: 'ws-1', email: 'a@b.test', role: 'admin' }))).toEqual({
      error: 'Choose a role.',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('explains a refusal and shows no link', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501' } })
    const state = await createInvite({}, inviteForm())
    expect(state.link).toBeUndefined()
    expect(state.error).toMatch(/Only an owner/)
  })
})

describe('revokeInvite', () => {
  it('sets revoked_at, and says so when no pending invitation was changed', async () => {
    update.mockResolvedValue({ data: [{ id: 'inv-1' }], error: null })
    expect(await revokeInvite('inv-1')).toEqual({})
    expect(update).toHaveBeenCalledWith({ revoked_at: expect.any(String) })

    update.mockResolvedValue({ data: [], error: null })
    expect((await revokeInvite('inv-1')).error).toMatch(/no longer pending/)
  })
})

describe('removeMember and setMemberRole', () => {
  it('call the database functions as the user', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await removeMember('ws-1', 'u2')).toEqual({})
    expect(rpc).toHaveBeenCalledWith('remove_member', { ws: 'ws-1', member: 'u2' })
    expect(await setMemberRole('ws-1', 'u2', 'owner')).toEqual({})
    expect(rpc).toHaveBeenCalledWith('set_member_role', { ws: 'ws-1', member: 'u2', role: 'owner' })
  })

  it('explain the last-owner refusal', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '23514' } })
    expect((await removeMember('ws-1', 'u1')).error).toMatch(/at least one owner/)
    expect((await setMemberRole('ws-1', 'u1', 'member')).error).toMatch(/at least one owner/)
  })

  it('refuse a role other than owner or member before calling the database', async () => {
    expect(await setMemberRole('ws-1', 'u2', 'admin')).toEqual({ error: 'Choose a role.' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
