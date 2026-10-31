import 'server-only'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { REQUEST_PATH_HEADER, signInPath } from './paths'

/**
 * A client for the signed-in user, for server actions. A visitor whose session ended while the page
 * was open (signed out in another tab, or the token revoked or expired) is sent to sign-in with that
 * page as next (ARCHITECTURE.md section 6.2).
 */
export async function signedInClient() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect(signInPath((await headers()).get(REQUEST_PATH_HEADER)))
  return supabase
}
