import { describe, expect, it } from 'vitest'
import { DEFAULT_PATH, isPublicPath, safeNextPath, signInUrl } from './paths'

describe('safeNextPath', () => {
  it('keeps a path on this site, with its query and hash', () => {
    expect(safeNextPath('/documents?status=failed#top')).toBe('/documents?status=failed#top')
  })

  it.each([null, '', 'documents', 'https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)'])(
    'sends %j to the document list instead',
    (next) => {
      expect(safeNextPath(next)).toBe(DEFAULT_PATH)
    },
  )

  it('never sends a signed-in user back to sign-in or the callback', () => {
    expect(safeNextPath('/sign-in?next=/x')).toBe(DEFAULT_PATH)
    expect(safeNextPath('/auth/callback?code=x')).toBe(DEFAULT_PATH)
  })

  it('lands on the document list by default (OQ-34)', () => {
    expect(DEFAULT_PATH).toBe('/documents')
  })
})

describe('isPublicPath', () => {
  it.each(['/', '/demo', '/demo/invoice-1', '/sign-in', '/privacy', '/terms', '/auth/callback', '/api/stripe/webhook'])(
    '%s is public',
    (path) => {
      expect(isPublicPath(path)).toBe(true)
    },
  )

  it.each(['/documents', '/settings', '/demonstration', '/sign-in-elsewhere', '/api/documents/1', '/privacy/x'])(
    '%s needs a session',
    (path) => {
      expect(isPublicPath(path)).toBe(false)
    },
  )
})

describe('signInUrl', () => {
  it('carries the page the visitor asked for, with its query', () => {
    const url = signInUrl(new URL('http://site.test/documents?status=failed'))
    expect(url.origin).toBe('http://site.test')
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('next')).toBe('/documents?status=failed')
  })
})
