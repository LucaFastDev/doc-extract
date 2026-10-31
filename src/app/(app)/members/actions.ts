'use server'

import { revalidatePath } from 'next/cache'
import { signedInClient } from '@/lib/auth/server'
import { inviteUrl } from '@/lib/site'
import { createInviteError, isRole, memberChangeError } from '@/lib/workspace/members'

// Invitations and roles (PRD US-8.2, OQ-18 to OQ-20). Each action runs as the signed-in user, and
// the database decides: create_invite, remove_member and set_member_role check that the caller owns
// the workspace and keep it an owner; RLS lets only an owner revoke an invitation.

export interface InviteState {
  error?: string
  link?: string
  email?: string
}

export interface ChangeResult {
  error?: string
}

export async function createInvite(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const supabase = await signedInClient()
  const ws = String(formData.get('workspace') ?? '')
  const email = String(formData.get('email') ?? '').trim()
  const role = formData.get('role')
  if (!email) return { error: 'Enter an email address.' }
  if (!isRole(role)) return { error: 'Choose a role.' }

  const { data: token, error } = await supabase.rpc('create_invite', { ws, email, role })
  if (error || typeof token !== 'string') return { error: createInviteError(error?.code) }

  revalidatePath('/members')
  return { link: inviteUrl(token), email: email.toLowerCase() }
}

export async function revokeInvite(id: string): Promise<ChangeResult> {
  const supabase = await signedInClient()
  // RLS lets only an owner revoke, and only a pending invitation; otherwise no row comes back.
  const { data, error } = await supabase
    .from('workspace_invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
  if (error || !data?.length) return { error: 'This invitation is no longer pending, or only an owner can revoke it.' }

  revalidatePath('/members')
  return {}
}

export async function removeMember(ws: string, member: string): Promise<ChangeResult> {
  const supabase = await signedInClient()
  const { error } = await supabase.rpc('remove_member', { ws, member })
  if (error) return { error: memberChangeError(error.code) }

  revalidatePath('/', 'layout')
  return {}
}

export async function setMemberRole(ws: string, member: string, role: string): Promise<ChangeResult> {
  const supabase = await signedInClient()
  if (!isRole(role)) return { error: 'Choose a role.' }
  const { error } = await supabase.rpc('set_member_role', { ws, member, role })
  if (error) return { error: memberChangeError(error.code) }

  revalidatePath('/', 'layout')
  return {}
}
