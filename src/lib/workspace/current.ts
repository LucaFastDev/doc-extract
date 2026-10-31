// The current workspace is remembered in a cookie holding its id. The cookie only chooses which of
// the user's own workspaces to show: it is checked against their memberships on every use, and
// RLS decides what they can read.

export const WORKSPACE_COOKIE = 'workspace'

export interface Membership {
  id: string
  name: string
  role: 'owner' | 'member'
  joinedAt: string
}

/**
 * The workspace named by the cookie if the user is a member of it; otherwise their personal
 * workspace, which is the first one they joined (made at sign-up, OQ-17).
 */
export function pickCurrentWorkspace(memberships: Membership[], cookieId: string | undefined): Membership | null {
  const chosen = memberships.find((m) => m.id === cookieId)
  if (chosen) return chosen
  const byJoined = [...memberships].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
  return byJoined[0] ?? null
}
