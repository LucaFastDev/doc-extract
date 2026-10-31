'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { WORKSPACE_COOKIE } from '@/lib/workspace/current'

// Workspace switch, create and rename (PRD US-8.1 AC-3 and AC-4, OQ-17), and sign-out (US-9.1
// AC-2). Each runs as the signed-in user: RLS and create_workspace() decide what is allowed, and
// the workspace cookie is only ever set to a workspace the user is a member of.

export interface FormState {
  error?: string
  ok?: boolean
}

async function rememberWorkspace(id: string) {
  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  })
}

export async function switchWorkspace(id: string): Promise<void> {
  const supabase = await createClient()
  const { data: member, error } = await supabase.rpc('is_member', { ws: id })
  if (error) throw error
  // Not a member: the cookie is left as it was, so the switch does nothing.
  if (member !== true) return
  await rememberWorkspace(id)
  revalidatePath('/', 'layout')
}

export async function createWorkspace(_prev: FormState, formData: FormData): Promise<FormState> {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Enter a name for the workspace.' }

  const supabase = await createClient()
  const { data: id, error } = await supabase.rpc('create_workspace', { name })
  if (error || typeof id !== 'string') return { error: 'The workspace could not be created. Try again.' }

  await rememberWorkspace(id)
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function renameWorkspace(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Enter a name for the workspace.' }

  const supabase = await createClient()
  // RLS lets only an owner update the row, so a member's rename changes nothing and returns no row.
  const { data, error } = await supabase.from('workspaces').update({ name }).eq('id', id).select('id')
  if (error || !data?.length) return { error: 'Only an owner can rename this workspace.' }

  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase.auth.signOut()
  if (error) throw error
  redirect('/')
}
