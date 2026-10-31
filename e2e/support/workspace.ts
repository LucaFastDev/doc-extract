import { expect, type BrowserContext, type Page } from '@playwright/test'
import { addCookies, cookieJarClient, sql, type TestUser } from './auth'

// Workspaces, members and invitations for the members and invitation specs (PRD US-8.2).

export function switcher(page: Page) {
  return page.getByRole('button', { name: /^Workspace: / })
}

export async function expectNoSideScroll(page: Page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(360)
}

/** The user's personal workspace, renamed so the switcher shows which one is current. */
export async function personalWorkspace(user: TestUser, name: string): Promise<string> {
  const [row] = await sql<{ workspace_id: string }>(
    `update public.workspaces w set name = $2 from public.workspace_members m
     where m.workspace_id = w.id and m.user_id = $1 returning m.workspace_id`,
    [user.id, name],
  )
  return row.workspace_id
}

/** Adds the user to the workspace directly in the database, as only an invitation can in the app. */
export async function addMember(ws: string, user: TestUser, role: 'owner' | 'member') {
  await sql('insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)', [
    ws,
    user.id,
    role,
  ])
}

export async function roleOf(ws: string, user: TestUser): Promise<string | null> {
  const rows = await sql<{ role: string }>(
    'select role from public.workspace_members where workspace_id = $1 and user_id = $2',
    [ws, user.id],
  )
  return rows[0]?.role ?? null
}

/** Makes an invitation as the owner, through create_invite, and returns its token. */
export async function invite(owner: TestUser, ws: string, email: string, role: 'owner' | 'member') {
  const { client } = cookieJarClient()
  const signIn = await client.auth.signInWithPassword({ email: owner.email, password: owner.password })
  if (signIn.error) throw signIn.error
  const { data, error } = await client.rpc('create_invite', { ws, email, role })
  if (error) throw error
  return data as string
}

/** Makes the workspace the current one in the browser, as the switcher would. */
export async function useWorkspace(context: BrowserContext, baseURL: string, ws: string) {
  await context.addCookies([{ name: 'workspace', value: ws, url: baseURL }])
}

/**
 * Signs the user in through /auth/callback, the same PKCE round trip as Google's, through the
 * test-only email provider: a magic link whose code the callback exchanges with the verifier cookie
 * the sign-in left in the browser. The browser ends on the callback's redirect, to `next`.
 */
export async function signInThroughCallback(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  user: TestUser,
  next: string,
) {
  const callback = new URL('/auth/callback', baseURL)
  callback.searchParams.set('next', next)
  const { client, cookies } = cookieJarClient()
  const { error } = await client.auth.signInWithOtp({
    email: user.email,
    options: { shouldCreateUser: false, emailRedirectTo: callback.toString() },
  })
  if (error) throw error
  await addCookies(context, baseURL, cookies())
  const [token] = await sql<{ token_hash: string }>(
    'select token_hash from auth.one_time_tokens where user_id = $1 order by created_at desc limit 1',
    [user.id],
  )
  const verify = new URL('/auth/v1/verify', process.env.NEXT_PUBLIC_SUPABASE_URL)
  verify.searchParams.set('token', token.token_hash)
  verify.searchParams.set('type', 'magiclink')
  verify.searchParams.set('redirect_to', callback.toString())
  await page.goto(verify.toString())
}
