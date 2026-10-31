import { beforeEach, describe, expect, it, vi } from 'vitest'

let user: { id: string } | null = null
const rpc = vi.fn()
const setCookie = vi.fn()

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`)
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc,
  }),
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: setCookie }),
  headers: async () => new Headers({ 'x-request-path': '/invite/abc123' }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { acceptInvite } = await import('./actions')

function tokenForm(token: string) {
  const data = new FormData()
  data.set('token', token)
  return data
}

async function redirectOf(action: Promise<unknown>) {
  const error = await action.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Redirected)
  return new URL((error as Redirected).to, 'http://site.test')
}

describe('acceptInvite', () => {
  beforeEach(() => {
    user = { id: 'u1' }
    rpc.mockReset()
    setCookie.mockReset()
  })

  it('sends a signed-out visitor to sign-in, coming back to the invitation', async () => {
    user = null
    const url = await redirectOf(acceptInvite({}, tokenForm('abc123')))
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('next')).toBe('/invite/abc123')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('accepts as the user, makes the workspace current and opens the documents', async () => {
    rpc.mockResolvedValue({ data: 'ws-9', error: null })
    const url = await redirectOf(acceptInvite({}, tokenForm('abc123')))
    expect(rpc).toHaveBeenCalledWith('accept_invite', { token: 'abc123' })
    expect(setCookie).toHaveBeenCalledWith('workspace', 'ws-9', expect.objectContaining({ httpOnly: true }))
    expect(url.pathname).toBe('/documents')
  })

  it.each([
    ['42501', 'not-for-you'],
    ['P0002', 'no-longer-valid'],
    ['23505', 'already-member'],
    ['08006', 'failed'],
  ])('reports refusal %s as %s and changes no cookie', async (code, refusal) => {
    rpc.mockResolvedValue({ data: null, error: { code } })
    expect(await acceptInvite({}, tokenForm('abc123'))).toEqual({ refusal })
    expect(setCookie).not.toHaveBeenCalled()
  })
})
