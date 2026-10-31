import { createBrowserClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

// The backend target comes only from the environment: a missing value fails here, at load, rather
// than sending requests to a default project. Next.js inlines NEXT_PUBLIC_ variables at build time,
// so each is read by its full name.
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`)
  }
  return value
}

const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL)
const supabaseAnonKey = required('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

/** The browser client, for client components. */
export function createClient() {
  return createBrowserClient(supabaseUrl, supabaseAnonKey)
}

/**
 * A browser client with no session, whoever is signed in: the anon role, for the public demo
 * (ARCHITECTURE.md section 10). It keeps nothing in storage and never refreshes a token.
 */
export function createAnonClient() {
  return createSupabaseClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'demo-anon' },
  })
}
