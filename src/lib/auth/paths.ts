// Where sign-in sends people (ARCHITECTURE.md section 6.2, OQ-34). Plain functions, shared by the
// proxy, the sign-in page and /auth/callback.

/** Where a signed-in user lands when no return-to path is given: the document list. */
export const DEFAULT_PATH = '/documents'

// Pages a signed-out visitor may open. A protected page not listed here sends them to sign-in; an
// address under neither list is no route and answers 404 (see PROTECTED_PREFIXES below).
const PUBLIC_PATHS = ['/', '/sign-in', '/privacy', '/terms', '/auth/callback', '/api/stripe/webhook']
const PUBLIC_PREFIXES = ['/demo']

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

// The areas of the site that need a session: the signed-in pages, the invitation page and the API.
// A path in none of these lists and under none of these prefixes is no route of ours, so a
// signed-out visitor gets the site's 404 page for it instead of sign-in. A new top-level route
// must be added to one list: a test reads src/app and fails for a route in neither.
export const PROTECTED_PREFIXES = ['/documents', '/members', '/billing', '/invite', '/api']

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

const NEVER_RETURN_TO = ['/sign-in', '/auth/callback']

// A backslash or a control character anywhere in the raw value.
const UNSAFE_CHARACTER = /[\\\p{Cc}]/u
// Exactly one slash, then a character that is neither a slash nor a backslash.
const ONE_LEADING_SLASH = /^\/[^/\\]/

/**
 * The return-to path, or the document list. It returns `DEFAULT_PATH` unless `next` starts with one
 * slash (not two), holds no backslash or control character, and parses as a URL on this site whose
 * path is not sign-in or the callback. Otherwise it returns that URL's path, query and hash after
 * parsing, which resolves dot segments, and only if that result starts with exactly one slash
 * followed by a character that is neither a slash nor a backslash; any other result is refused too.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || UNSAFE_CHARACTER.test(next)) return DEFAULT_PATH
  const base = 'http://site.invalid'
  let url: URL
  try {
    url = new URL(next, base)
  } catch {
    return DEFAULT_PATH
  }
  if (url.origin !== base || NEVER_RETURN_TO.includes(url.pathname)) return DEFAULT_PATH
  const path = `${url.pathname}${url.search}${url.hash}`
  return ONE_LEADING_SLASH.test(path) ? path : DEFAULT_PATH
}

/** The sign-in page, carrying the page the visitor asked for as `next`. */
export function signInUrl(requested: URL): URL {
  const url = new URL('/sign-in', requested.origin)
  url.searchParams.set('next', `${requested.pathname}${requested.search}`)
  return url
}

/**
 * The request header in which the proxy passes on the path and query a request was made to, so a
 * server action, which is a POST to the page it runs on, knows that page. The proxy always sets it,
 * so a value the browser sent never arrives.
 */
export const REQUEST_PATH_HEADER = 'x-request-path'

/**
 * Where a server action or page sends a visitor it finds without a session: sign-in, with `next`
 * the page they were on, passed through `safeNextPath`.
 */
export function signInPath(next: string | null | undefined): string {
  return `/sign-in?${new URLSearchParams({ next: safeNextPath(next) })}`
}
