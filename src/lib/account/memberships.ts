import type { SupabaseClient } from '@supabase/supabase-js'

// Which of a user's workspaces stop their account being deleted, and which go with it (PRD US-18.2,
// OQ-20, OQ-30, issue #61 rulings 5 and 8), read as the caller through RLS: by DELETE /api/account,
// and by the account dialog when it opens. No server-only import, because the dialog uses it too.

export interface MemberRow {
  workspaceId: string
  name: string
  userId: string
  role: 'owner' | 'member'
}

export interface AccountWorkspace {
  id: string
  name: string
}

interface MemberQueryRow {
  workspace_id: string
  user_id: string
  role: MemberRow['role']
  workspaces: { name: string } | null
}

const PAGE_SIZE = 500

/**
 * Every membership of every workspace the caller belongs to, which is what workspace_members' select
 * policy returns. It reads page by page, so the API's row limit cannot hide a member and make a
 * shared workspace look like the caller's alone.
 */
export async function readMembers(client: SupabaseClient): Promise<MemberRow[]> {
  const rows: MemberRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('workspace_members')
      .select('workspace_id, user_id, role, workspaces(name)')
      .order('workspace_id')
      .order('user_id')
      .range(from, from + PAGE_SIZE - 1)
      .returns<MemberQueryRow[]>()
    if (error) throw error
    for (const row of data) {
      rows.push({ workspaceId: row.workspace_id, name: row.workspaces?.name ?? '', userId: row.user_id, role: row.role })
    }
    if (data.length < PAGE_SIZE) return rows
  }
}

/**
 * soleMember: the workspaces with the user as their one member, whatever their role, which go with
 * the account; pending invitations do not count. onlyOwner: those with other members and no other
 * owner, which refuse the deletion. A workspace in neither list stays, and the user leaves it.
 */
export function sortAccountWorkspaces(rows: MemberRow[], userId: string): { soleMember: AccountWorkspace[]; onlyOwner: AccountWorkspace[] } {
  const byWorkspace = new Map<string, MemberRow[]>()
  for (const row of rows) byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row])

  const soleMember: AccountWorkspace[] = []
  const onlyOwner: AccountWorkspace[] = []
  for (const [id, members] of byWorkspace) {
    const mine = members.find((m) => m.userId === userId)
    if (!mine) continue
    const workspace = { id, name: mine.name }
    if (members.length === 1) soleMember.push(workspace)
    else if (mine.role === 'owner' && !members.some((m) => m.userId !== userId && m.role === 'owner')) onlyOwner.push(workspace)
  }
  const byName = (a: AccountWorkspace, b: AccountWorkspace) => a.name.localeCompare(b.name)
  return { soleMember: soleMember.sort(byName), onlyOwner: onlyOwner.sort(byName) }
}

/** The sentence a refused deletion shows (ruling 8). */
export function refusalMessage(names: string[]): string {
  return `You are the only owner of ${names.join(', ')}, which still have other members. Make another member an owner of each, or delete it first.`
}

/** What the account dialog adds when workspaces go with the account (ruling 8). */
export function soleMemberNote(names: string[]): string {
  return `These workspaces have no other members and are deleted with all their data: ${names.join(', ')}.`
}

/** What either deletion dialog shows on any failure (ruling 8). */
export const DELETE_FAILED = 'This could not be deleted. Try again.'
