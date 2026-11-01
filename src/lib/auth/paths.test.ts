import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PATH, isProtectedPath, isPublicPath, safeNextPath, signInPath, signInUrl } from './paths'

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

  // Each of these passes a check on the raw value alone, but URL parsing resolves its dot segments
  // to //evil.example/x, which a browser reads as another host.
  it.each(['/.//evil.example/x', '/a/..//evil.example/x', '/%2e//evil.example/x', '/./\\evil.example/x'])(
    'sends %j, which parses to a path starting with two slashes, to the document list',
    (next) => {
      expect(safeNextPath(next)).toBe(DEFAULT_PATH)
    },
  )

  it.each(['/documents\\x', '/\t/evil.example/x', '/documents\nx', '/documents\u0000x', '/documents\u007fx'])(
    'sends %j, which holds a backslash or a control character, to the document list',
    (next) => {
      expect(safeNextPath(next)).toBe(DEFAULT_PATH)
    },
  )

  it('keeps an encoded slash as part of one path segment, on this site', () => {
    expect(safeNextPath('/.%2f/evil.example')).toBe('/.%2f/evil.example')
  })

  it('still resolves dot segments that stay on this site', () => {
    expect(safeNextPath('/a/../documents?x=1')).toBe('/documents?x=1')
  })

  it.each([
    '/.//evil.example/x',
    '/a/..//evil.example/x',
    '/%2e//evil.example/x',
    '/.%2f/evil.example',
    '/./\\evil.example/x',
    '//evil.example/x',
    '/\\evil.example',
    '/\t/evil.example/x',
  ])('returns for %j a path that a browser resolves on this site', (next) => {
    const site = 'https://site.test'
    expect(new URL(safeNextPath(next), site).origin).toBe(site)
  })

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

describe('isProtectedPath', () => {
  it.each(['/documents', '/documents/export', '/documents/1', '/members', '/billing', '/invite/abc', '/api/documents/1'])(
    '%s is protected',
    (path) => {
      expect(isProtectedPath(path)).toBe(true)
    },
  )

  it.each(['/this-does-not-exist', '/settings', '/documentsx', '/membership'])('%s is no route of ours', (path) => {
    expect(isProtectedPath(path)).toBe(false)
  })

  // The proxy lets a path that is neither public nor protected through to the 404 page, so a route
  // added to src/app and put in neither list would be open to a signed-out visitor at the proxy.
  it('covers every route in src/app, as public or protected', () => {
    const app = join(process.cwd(), 'src/app')
    const routes = new Set<string>()
    const walk = (dir: string, segments: string[]) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const group = entry.name.startsWith('(') && entry.name.endsWith(')')
          walk(join(dir, entry.name), group ? segments : [...segments, entry.name])
        } else if (/^(page|route)\.(tsx?|jsx?)$/.test(entry.name) && segments.length > 0) {
          // A dynamic segment, [id], stands for any value.
          routes.add(`/${segments.map((s) => s.replace(/^\[.*\]$/, 'x')).join('/')}`)
        }
      }
    }
    walk(app, [])
    expect(routes.size).toBeGreaterThan(5)
    for (const route of routes) {
      expect(isPublicPath(route) || isProtectedPath(route), route).toBe(true)
    }
  })
})

describe('signInUrl', () => {
  it('carries the page the visitor asked for, with its query', () => {
    const url = signInUrl(new URL('http://site.test/documents?status=failed'))
    expect(url.origin).toBe('http://site.test')
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('next')).toBe('/documents?status=failed')
  })
})

describe('signInPath', () => {
  it('carries the page, with its query, as next', () => {
    const url = new URL(signInPath('/documents?status=failed'), 'http://site.test')
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('next')).toBe('/documents?status=failed')
  })

  it.each([null, '//evil.example/x', '/.//evil.example/x', '/sign-in?next=%2Fdocuments'])(
    'passes next through safeNextPath, so %s gives the document list',
    (next) => {
      const url = new URL(signInPath(next), 'http://site.test')
      expect(url.origin).toBe('http://site.test')
      expect(url.searchParams.get('next')).toBe(DEFAULT_PATH)
    },
  )
})
