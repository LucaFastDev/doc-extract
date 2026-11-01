import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SiteFooter } from '@/components/site-footer'
import { portfolioUrl } from '@/lib/landing/portfolio'

// The landing page footer (issue #45 criterion 5, ruling 3): the Portfolio link exists only when
// NEXT_PUBLIC_PORTFOLIO_URL is set.

afterEach(() => vi.unstubAllEnvs())

describe('portfolioUrl', () => {
  it('is null for an unset, empty or non-http value', () => {
    expect(portfolioUrl(undefined)).toBeNull()
    expect(portfolioUrl('')).toBeNull()
    expect(portfolioUrl('   ')).toBeNull()
    expect(portfolioUrl('not a url')).toBeNull()
    expect(portfolioUrl('javascript:alert(1)')).toBeNull()
  })

  it('is the address for an http or https value', () => {
    expect(portfolioUrl('https://portfolio.example/me')).toBe('https://portfolio.example/me')
    expect(portfolioUrl(' https://portfolio.example/ ')).toBe('https://portfolio.example/')
  })
})

describe('SiteFooter', () => {
  it('links the source code, privacy and terms, and the portfolio when its address is set', () => {
    vi.stubEnv('NEXT_PUBLIC_PORTFOLIO_URL', 'https://portfolio.example/me')
    const html = renderToStaticMarkup(createElement(SiteFooter))
    expect(html).toContain('href="https://github.com/LucaFastDev/doc-extract"')
    expect(html).toContain('>Source code<')
    expect(html).toContain('href="https://portfolio.example/me"')
    expect(html).toContain('>Portfolio<')
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('>Privacy<')
    expect(html).toContain('href="/terms"')
    expect(html).toContain('>Terms<')
  })

  it('has no Portfolio link when the address is unset or empty', () => {
    for (const value of [undefined, '']) {
      vi.stubEnv('NEXT_PUBLIC_PORTFOLIO_URL', value)
      const html = renderToStaticMarkup(createElement(SiteFooter))
      expect(html).not.toContain('Portfolio')
      expect(html).toContain('>Source code<')
    }
  })
})
