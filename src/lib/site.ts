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
