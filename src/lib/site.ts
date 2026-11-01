import 'server-only'

// The site's own address, from SITE_URL (ARCHITECTURE.md section 12): `<site>` in production, the
// dev server's address locally. A missing or malformed value fails here, when a link is built,
// rather than handing out links to the wrong place.
function siteUrl(): URL {
  const value = process.env.SITE_URL
  if (!value) throw new Error('SITE_URL is not set. Set it to the address the site is served on.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('SITE_URL is not an absolute URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('SITE_URL must be an http or https URL.')
  return url
}

/** The copy-link for an invitation, `<site>/invite/<token>` (OQ-19). */
export function inviteUrl(token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, siteUrl()).toString()
}

/** The billing page, where a cancelled Checkout and the customer portal return to (Lead ruling 6 on #50). */
export function billingUrl(): string {
  return new URL('/billing', siteUrl()).toString()
}

/**
 * Where a completed Checkout returns to: the billing page, naming the workspace that went to Checkout
 * (Lead ruling 8 on #50). The page acts on it only for that workspace and only for an owner of it.
 */
export function checkoutSuccessUrl(workspaceId: string): string {
  const url = new URL('/billing', siteUrl())
  url.searchParams.set('checkout', 'success')
  url.searchParams.set('workspace', workspaceId)
  return url.toString()
}
