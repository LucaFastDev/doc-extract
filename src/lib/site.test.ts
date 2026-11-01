import { afterEach, describe, expect, it, vi } from 'vitest'
import { billingUrl, checkoutSuccessUrl, inviteUrl } from './site'

describe('billingUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds the billing page, with no marker, from SITE_URL', () => {
    vi.stubEnv('SITE_URL', 'https://site.test/')
    expect(billingUrl()).toBe('https://site.test/billing')
  })

  it('throws when SITE_URL is unset', () => {
    vi.stubEnv('SITE_URL', '')
    expect(() => billingUrl()).toThrow(/SITE_URL/)
  })
})

describe('checkoutSuccessUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds the return from a completed Checkout from SITE_URL, naming the workspace', () => {
    vi.stubEnv('SITE_URL', 'https://site.test/')
    expect(checkoutSuccessUrl('11111111-2222-3333-4444-555555555555')).toBe(
      'https://site.test/billing?checkout=success&workspace=11111111-2222-3333-4444-555555555555',
    )
  })

  it('throws when SITE_URL is unset', () => {
    vi.stubEnv('SITE_URL', '')
    expect(() => checkoutSuccessUrl('ws')).toThrow(/SITE_URL/)
  })
})

describe('inviteUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds <site>/invite/<token> from SITE_URL', () => {
    vi.stubEnv('SITE_URL', 'https://site.test')
    expect(inviteUrl('ab12')).toBe('https://site.test/invite/ab12')
  })

  it('ignores a trailing slash or a path on SITE_URL', () => {
    vi.stubEnv('SITE_URL', 'https://site.test/some/path/')
    expect(inviteUrl('ab12')).toBe('https://site.test/invite/ab12')
  })

  it.each([
    ['unset', ''],
    ['not a URL', 'site.test'],
    ['not http', 'javascript:alert(1)'],
  ])('throws when SITE_URL is %s', (_name, value) => {
    vi.stubEnv('SITE_URL', value)
    expect(() => inviteUrl('ab12')).toThrow(/SITE_URL/)
  })
})
