import { describe, expect, it, vi } from 'vitest'

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`)
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'x-request-path': '/documents?status=failed' }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))

const { getWorkspaceContext } = await import('./server')

describe('getWorkspaceContext', () => {
  it('sends a visitor without a session to sign-in with the page as next', async () => {
    const error = await getWorkspaceContext().then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Redirected)
    const url = new URL((error as Redirected).to, 'http://site.test')
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('next')).toBe('/documents?status=failed')
  })
})
