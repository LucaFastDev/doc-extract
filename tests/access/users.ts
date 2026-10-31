import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { withDb } from './local-db'

// Test users (ARCHITECTURE.md section 4.4): Google cannot be driven from a test, so the local stack
// enables the email provider with passwords. Users are created with the admin API and signed in
// through the API with the anon key, exactly as the browser's client would be.

const LOCAL_API_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Put the values from \`npx supabase status\` in .env.local.`)
  return value
}

function apiUrl(): string {
  const url = env('NEXT_PUBLIC_SUPABASE_URL')
  if (!LOCAL_API_URL.test(url)) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not the local stack; access tests never run against a hosted project.')
  }
  return url
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

/** A client with no session: the anon role. */
export function anonClient(): SupabaseClient {
  return createClient(apiUrl(), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), noSession)
}

/** The service-role client, for setting up rows the API refuses to clients. */
export function adminClient(): SupabaseClient {
  return createClient(apiUrl(), env('SUPABASE_SERVICE_ROLE_KEY'), noSession)
}

export interface TestUser {
  id: string
  email: string
  client: SupabaseClient
}

/** Creates a confirmed user with the admin API and returns a client signed in as them. */
export async function signUp(fullName = 'Test User'): Promise<TestUser> {
  const email = `access-${randomUUID()}@example.test`
  const password = randomUUID()
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error) throw error
  const client = anonClient()
  const signIn = await client.auth.signInWithPassword({ email, password })
  if (signIn.error) throw signIn.error
  return { id: data.user.id, email, client }
}

/** The one workspace the trigger made for this user at sign-up. */
export async function personalWorkspaceId(user: TestUser): Promise<string> {
  const { data, error } = await user.client.from('workspace_members').select('workspace_id').eq('user_id', user.id)
  if (error) throw error
  if (data.length !== 1) throw new Error(`expected one workspace, got ${data.length}`)
  return data[0].workspace_id as string
}

/** Adds the user to the workspace directly in the database, as clients cannot. */
export async function addMember(ws: string, user: TestUser, role: 'owner' | 'member'): Promise<void> {
  await withDb((db) =>
    db.query('insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)', [ws, user.id, role]),
  )
}
