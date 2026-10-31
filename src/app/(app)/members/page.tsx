import type { Metadata } from 'next'
import { getWorkspaceContext } from '@/lib/workspace/server'
import type { Role } from '@/lib/workspace/members'
import { InviteDialog } from './invite-dialog'
import { InviteList, type PendingInvite } from './invite-list'
import { MemberList, type Member } from './member-list'

export const metadata: Metadata = { title: 'Members · doc-extract' }

interface MemberRow {
  user_id: string
  role: Role
  profiles: { email: string; display_name: string | null } | null
}

interface InviteRow {
  id: string
  email: string
  role: Role
  expires_at: string
}

const EXPIRY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

// The current workspace's members and, for an owner, its pending invitations and the controls to
// invite, revoke, remove and change roles (PRD US-8.2, OQ-20). Read as the user, through RLS: a
// member is shown no invitations because RLS returns them only to an owner.
export default async function MembersPage() {
  const { supabase, user, current } = await getWorkspaceContext()
  if (!current) return null
  const isOwner = current.role === 'owner'

  const { data: memberRows, error } = await supabase
    .from('workspace_members')
    .select('user_id, role, profiles(email, display_name)')
    .eq('workspace_id', current.id)
    .order('created_at')
    .returns<MemberRow[]>()
  if (error) throw error
  const members: Member[] = memberRows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    name: row.profiles?.display_name || row.profiles?.email || 'Unknown user',
    email: row.profiles?.email ?? '',
  }))

  let invites: PendingInvite[] = []
  if (isOwner) {
    const { data, error: invitesError } = await supabase
      .from('workspace_invites')
      .select('id, email, role, expires_at')
      .eq('workspace_id', current.id)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .returns<InviteRow[]>()
    if (invitesError) throw invitesError
    invites = data.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      expires: EXPIRY.format(new Date(row.expires_at)),
    }))
  }

  return (
    <main className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
          <p className="text-muted-foreground">
            People in <span className="font-medium text-foreground">{current.name}</span>.
          </p>
        </div>
        {isOwner && <InviteDialog workspaceId={current.id} />}
      </div>
      <MemberList
        workspace={{ id: current.id, name: current.name }}
        members={members}
        viewerId={user.id}
        canManage={isOwner}
      />
      {isOwner && <InviteList invites={invites} />}
    </main>
  )
}
