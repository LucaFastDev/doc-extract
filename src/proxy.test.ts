import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let signedIn = false

vi.mock('@/lib/supabase/proxy', () => ({
  updateSession: async () => {
    const response = NextResponse.next()
    response.cookies.set('sb-test-auth-token', 'refreshed')
    return { response, user: signedIn ? { id: 'u1' } : null }
  },
}))

const { proxy, config } = await import('./proxy')

function visit(path: string) {
  return proxy(new NextRequest(`http://site.test${path}`))
}

describe('src/proxy.ts', () => {
  beforeEach(() => {
    signedIn = false
  })

  it('sends a signed-out visitor of an app page to sign-in with the return-to path', async () => {
    const response = await visit('/documents?status=failed')
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('next')).toBe('/documents?status=failed')
  })

  it.each(['/', '/sign-in', '/auth/callback', '/demo/a', '/privacy', '/terms'])(
    'lets a signed-out visitor open public page %s',
    async (path) => {
      const response = await visit(path)
      expect(response.headers.get('location')).toBeNull()
    },
  )

  it('lets a signed-in user through, with the refreshed session cookie', async () => {
    signedIn = true
    const response = await visit('/documents')
    expect(response.headers.get('location')).toBeNull()
    expect(response.cookies.get('sb-test-auth-token')?.value).toBe('refreshed')
  })

  it('does not run on static files', () => {
    const [matcher] = config.matcher
    const re = new RegExp(`^${matcher}$`)
    expect(re.test('/documents')).toBe(true)
    expect(re.test('/_next/static/chunk.js')).toBe(false)
    expect(re.test('/favicon.ico')).toBe(false)
  })
})
