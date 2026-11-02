'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { signedInClient } from '@/lib/auth/server'
import { createClient } from '@/lib/supabase/server'
import { setCurrentWorkspace } from '@/lib/workspace/server'

// Workspace switch, create and rename (PRD US-8.1 AC-3 and AC-4, OQ-17), and sign-out (US-9.1
// AC-2). Each runs as the signed-in user: RLS and create_workspace() decide what is allowed, and
// the workspace cookie is only ever set to a workspace the user is a member of.

export interface FormState {
  error?: string
  ok?: boolean
}

const NAME_TOO_LONG = 'Use 100 characters or fewer for the workspace name.'

// Counts code points, as char_length does in the database's check on workspaces.name.
function nameTooLong(name: string) {
  return Array.from(name).length > 100
}

export async function switchWorkspace(id: string): Promise<void> {
  const supabase = await signedInClient()
  const { data: member, error } = await supabase.rpc('is_member', { ws: id })
  if (error) throw error
  // Not a member: the cookie is left as it was, so the switch does nothing.
  if (member !== true) return
  await setCurrentWorkspace(id)
  revalidatePath('/', 'layout')
}

export async function createWorkspace(_prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await signedInClient()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Enter a name for the workspace.' }
  if (nameTooLong(name)) return { error: NAME_TOO_LONG }

  const { data: id, error } = await supabase.rpc('create_workspace', { name })
  if (error || typeof id !== 'string') return { error: 'The workspace could not be created. Try again.' }

  await setCurrentWorkspace(id)
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function renameWorkspace(_prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await signedInClient()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Enter a name for the workspace.' }
  if (nameTooLong(name)) return { error: NAME_TOO_LONG }

  // RLS lets only an owner update the row, so a member's rename changes nothing and returns no row.
  const { data, error } = await supabase.from('workspaces').update({ name }).eq('id', id).select('id')
  if (error) return { error: 'The workspace could not be renamed. Try again.' }
  if (!data?.length) return { error: 'Only an owner can rename this workspace.' }

  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase.auth.signOut()
  if (error) throw error
  redirect('/')
}
