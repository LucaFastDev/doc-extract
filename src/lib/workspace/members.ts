// Roles, the last-owner rule and what the members screen says when the database refuses a change
// (PRD US-8.2, OQ-18 to OQ-20). Plain functions, shared by the members page, its actions and the
// invitation page. The database decides; these only explain its answers.

export type Role = 'owner' | 'member'

export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'member'
}

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', member: 'Member' }

export const LAST_OWNER_MESSAGE =
  'A workspace needs at least one owner. Make another member an owner first.'

/** True when this user is the workspace's only owner, so they can be neither removed nor demoted. */
export function isLastOwner(members: { userId: string; role: Role }[], userId: string): boolean {
  const owners = members.filter((m) => m.role === 'owner')
  return owners.length === 1 && owners[0].userId === userId
}

// The SQLSTATEs the invitation and role functions raise (supabase/migrations, milestone 3).
const NOT_ALLOWED = '42501'
const BAD_INPUT = '22023'
const NOT_FOUND = 'P0002'
const ALREADY_MEMBER = '23505'
const LAST_OWNER = '23514'

export function createInviteError(code: string | undefined): string {
  if (code === NOT_ALLOWED) return 'Only an owner can invite people to this workspace.'
  if (code === BAD_INPUT) return 'Enter a valid email address.'
  return 'The invitation could not be created. Try again.'
}

export function memberChangeError(code: string | undefined): string {
  if (code === LAST_OWNER) return LAST_OWNER_MESSAGE
  if (code === NOT_ALLOWED) return 'Only an owner can change members.'
  if (code === NOT_FOUND) return 'They are no longer a member of this workspace.'
  return 'The change could not be saved. Try again.'
}

export type AcceptRefusal = 'not-for-you' | 'no-longer-valid' | 'already-member' | 'failed'

export function acceptRefusal(code: string | undefined): AcceptRefusal {
  if (code === NOT_ALLOWED) return 'not-for-you'
  if (code === NOT_FOUND) return 'no-longer-valid'
  if (code === ALREADY_MEMBER) return 'already-member'
  return 'failed'
}
