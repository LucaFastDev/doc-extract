import 'server-only'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { REQUEST_PATH_HEADER, signInPath } from '@/lib/auth/paths'
import { createClient } from '@/lib/supabase/server'
import { pickCurrentWorkspace, WORKSPACE_COOKIE, type Membership } from './current'

interface MembershipRow {
  role: Membership['role']
  created_at: string
  workspaces: { id: string; name: string } | null
}

/**
 * The signed-in user, their workspaces and the current one, read as the user through RLS. Sends a
 * visitor without a session to sign-in with the page as next; the proxy has already for a page
 * load. Cached per request, so the layout and the page share one read.
 */
export const getWorkspaceContext = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect(signInPath((await headers()).get(REQUEST_PATH_HEADER)))

  const { data, error } = await supabase
    .from('workspace_members')
    .select('role, created_at, workspaces(id, name)')
    .eq('user_id', user.id)
    .returns<MembershipRow[]>()
  if (error) throw error

  const memberships: Membership[] = data
    .filter((row) => row.workspaces)
    .map((row) => ({ id: row.workspaces!.id, name: row.workspaces!.name, role: row.role, joinedAt: row.created_at }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const cookieStore = await cookies()
  const current = pickCurrentWorkspace(memberships, cookieStore.get(WORKSPACE_COOKIE)?.value)

  return { supabase, user, memberships, current }
})

/**
 * Makes the workspace the current one. Call it only with a workspace the user has just been found
 * to be a member of; getWorkspaceContext checks the cookie again on every use regardless.
 */
export async function setCurrentWorkspace(id: string) {
  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  })
}
