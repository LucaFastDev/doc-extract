import 'server-only'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

// The backend target comes only from the environment: a missing value fails here, at load, rather
// than sending requests to a default project.
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`)
  }
  return value
}

const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL)
const supabaseAnonKey = required('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

/** The server client, for server components and route handlers: acts as the signed-in user. */
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // A server component cannot set cookies; src/proxy.ts refreshes the session instead.
        }
      },
    },
  })
}

/** A client with no session, whoever is signed in: the anon role, for the public demo (section 10). */
export function createAnonClient() {
  return createSupabaseClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

/**
 * The service-role client, for the route handlers that must bypass RLS (ARCHITECTURE.md section
 * 6.2). It holds no session and throws when SUPABASE_SERVICE_ROLE_KEY is unset.
 */
export function createServiceRoleClient() {
  const key = required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY)
  return createSupabaseClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
