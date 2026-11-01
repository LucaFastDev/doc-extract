import { afterEach, describe, expect, it, vi } from 'vitest'
import { billingUrl, inviteUrl } from './site'

describe('billingUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds the billing page and the return from a completed Checkout from SITE_URL', () => {
    vi.stubEnv('SITE_URL', 'https://doc-extract.vercel.app/')
    expect(billingUrl()).toBe('https://doc-extract.vercel.app/billing')
    expect(billingUrl('success')).toBe('https://doc-extract.vercel.app/billing?checkout=success')
  })

  it('throws when SITE_URL is unset', () => {
    vi.stubEnv('SITE_URL', '')
    expect(() => billingUrl()).toThrow(/SITE_URL/)
  })
})

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
