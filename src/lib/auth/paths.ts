// Where sign-in sends people (ARCHITECTURE.md section 6.2, OQ-34). Plain functions, shared by the
// proxy, the sign-in page and /auth/callback.

/** Where a signed-in user lands when no return-to path is given: the document list. */
export const DEFAULT_PATH = '/documents'

// Pages a signed-out visitor may open. Everything else sends them to sign-in.
const PUBLIC_PATHS = ['/', '/sign-in', '/privacy', '/terms', '/auth/callback', '/api/stripe/webhook']
const PUBLIC_PREFIXES = ['/demo']

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

const NEVER_RETURN_TO = ['/sign-in', '/auth/callback']

/**
 * The return-to path, if it is a path on this site; otherwise the document list. Anything that
 * could leave the site (`https://…`, `//host`, `/\host`) is refused, so the callback is no open
 * redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return DEFAULT_PATH
  const base = 'http://site.invalid'
  let url: URL
  try {
    url = new URL(next, base)
  } catch {
    return DEFAULT_PATH
  }
  if (url.origin !== base || NEVER_RETURN_TO.includes(url.pathname)) return DEFAULT_PATH
  return `${url.pathname}${url.search}${url.hash}`
}

/** The sign-in page, carrying the page the visitor asked for as `next`. */
export function signInUrl(requested: URL): URL {
  const url = new URL('/sign-in', requested.origin)
  url.searchParams.set('next', `${requested.pathname}${requested.search}`)
  return url
}
