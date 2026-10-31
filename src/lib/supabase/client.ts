import { createBrowserClient } from '@supabase/ssr'

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
