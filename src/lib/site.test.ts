import { afterEach, describe, expect, it, vi } from 'vitest'
import { inviteUrl } from './site'

describe('inviteUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds <site>/invite/<token> from SITE_URL', () => {
    vi.stubEnv('SITE_URL', 'https://doc-extract.vercel.app')
    expect(inviteUrl('ab12')).toBe('https://doc-extract.vercel.app/invite/ab12')
  })

  it('ignores a trailing slash or a path on SITE_URL', () => {
    vi.stubEnv('SITE_URL', 'https://doc-extract.vercel.app/some/path/')
    expect(inviteUrl('ab12')).toBe('https://doc-extract.vercel.app/invite/ab12')
  })

  it.each([
    ['unset', ''],
    ['not a URL', 'doc-extract.vercel.app'],
    ['not http', 'javascript:alert(1)'],
  ])('throws when SITE_URL is %s', (_name, value) => {
    vi.stubEnv('SITE_URL', value)
    expect(() => inviteUrl('ab12')).toThrow(/SITE_URL/)
  })
})
