import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_PATH_HEADER } from '@/lib/auth/paths'

let signedIn = false
let passedOn: NextRequest | undefined

vi.mock('@/lib/supabase/proxy', () => ({
  updateSession: async (request: NextRequest) => {
    passedOn = request
    const response = NextResponse.next()
    response.cookies.set('sb-test-auth-token', 'refreshed')
    return { response, user: signedIn ? { id: 'u1' } : null }
  },
}))

const { proxy, config } = await import('./proxy')

function visit(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return proxy(new NextRequest(`http://site.test${path}`, init))
}

describe('src/proxy.ts', () => {
  beforeEach(() => {
    signedIn = false
    passedOn = undefined
  })

  it('sends a signed-out visitor of an app page to sign-in with the return-to path', async () => {
    const response = await visit('/documents?status=failed')
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('next')).toBe('/documents?status=failed')
  })

  it('passes a signed-out server action POST on to the action, which sends the visitor to sign-in itself', async () => {
    const response = await visit('/documents', { method: 'POST', headers: { 'next-action': 'abc' } })
    expect(response.headers.get('location')).toBeNull()
    expect(response.cookies.get('sb-test-auth-token')?.value).toBe('refreshed')
  })

  it('tells the page and its actions the path and query requested, over any value the browser sent', async () => {
    await visit('/documents?status=failed', { method: 'POST', headers: { [REQUEST_PATH_HEADER]: '//evil.example' } })
    expect(passedOn?.headers.get(REQUEST_PATH_HEADER)).toBe('/documents?status=failed')
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
