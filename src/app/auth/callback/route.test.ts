import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exchangeCodeForSession = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession } }),
}))

const { GET } = await import('./route')

function callback(query: string) {
  return GET(new NextRequest(`http://site.test/auth/callback${query}`))
}

describe('GET /auth/callback', () => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset()
  })

  it('exchanges the code and redirects to the return-to path', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    const response = await callback('?code=abc&next=%2Fdocuments%3Fstatus%3Dfailed')
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc')
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://site.test/documents?status=failed')
  })

  it('redirects to the document list when next is missing or off-site (OQ-34)', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    const response = await callback('?code=abc&next=https%3A%2F%2Fevil.example%2F')
    expect(response.headers.get('location')).toBe('http://site.test/documents')
  })

  it('sends a failed exchange back to sign-in, keeping the return-to path', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: new Error('invalid grant') })
    const response = await callback('?code=bad&next=%2Fdocuments')
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('error')).toBe('callback')
    expect(location.searchParams.get('next')).toBe('/documents')
  })

  it('sends a request without a code back to sign-in without calling Auth', async () => {
    const response = await callback('?error=access_denied&next=%2Fdocuments')
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/sign-in')
  })
})
