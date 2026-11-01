/**
 * The operator's portfolio address from NEXT_PUBLIC_PORTFOLIO_URL (issue #45, ruling 3), or null
 * when it is unset, empty or not an http or https address: the footer then has no Portfolio link.
 */
export function portfolioUrl(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:' ? trimmed : null
  } catch {
    return null
  }
}
