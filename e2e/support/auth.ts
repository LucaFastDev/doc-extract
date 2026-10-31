import { randomUUID } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

// Signing test users in (ARCHITECTURE.md section 4.4). Google cannot be driven from a test, so the
// local stack enables the email provider for tests only: users are made with the admin API and
// signed in with @supabase/ssr in Node, and its session cookies are given to the browser.

const LOCAL_API_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/
const LOCAL_DB_URL = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/postgres$/

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Put the values from \`npx supabase status\` in .env.local.`)
  return value
}

function apiUrl(): string {
  const url = env('NEXT_PUBLIC_SUPABASE_URL')
  if (!LOCAL_API_URL.test(url)) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not the local stack.')
  return url
}

export function adminClient() {
  return createClient(apiUrl(), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Runs one statement against the local database, as postgres. */
export async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const url = env('SUPABASE_DB_URL')
  if (!LOCAL_DB_URL.test(url)) throw new Error('SUPABASE_DB_URL is not the local stack.')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<T>(text, values)).rows
  } finally {
    await client.end()
  }
}

type Cookie = { name: string; value: string }

/** A server client whose cookies live in a plain map, as the browser's would. */
export function cookieJarClient() {
  const jar = new Map<string, string>()
  const client = createServerClient(apiUrl(), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies: Cookie[]) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value)
          else jar.delete(name)
        }
      },
    },
  })
  return { client, cookies: () => [...jar].map(([name, value]) => ({ name, value })) }
}

/** Gives the browser the cookies of a Node session, for the app's own origin. */
export async function addCookies(context: BrowserContext, baseURL: string, cookies: Cookie[]) {
  await context.addCookies(cookies.map((c) => ({ ...c, url: baseURL, sameSite: 'Lax' as const })))
}

export interface TestUser {
  id: string
  email: string
  password: string
}

/** A new confirmed user; the sign-up trigger gives them a profile and a personal workspace. */
export async function createUser(fullName = 'E2E User'): Promise<TestUser> {
  const email = `e2e-${randomUUID()}@example.test`
  const password = randomUUID()
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error) throw error
  return { id: data.user.id, email, password }
}

/** Signs the user in through the email provider and puts the session cookies in the browser. */
export async function signIn(context: BrowserContext, baseURL: string, user: TestUser) {
  const { client, cookies } = cookieJarClient()
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw error
  await addCookies(context, baseURL, cookies())
}
