import { NextResponse, type NextRequest } from 'next/server'
import { safeNextPath } from '@/lib/auth/paths'
import { createClient } from '@/lib/supabase/server'

// Google, through Supabase Auth, returns here with a PKCE code (ARCHITECTURE.md section 6.2).
// Exchanging it sets the session cookie; the user then lands on the page they first asked for,
// if it is on this site, else on the document list (OQ-34).
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const next = safeNextPath(request.nextUrl.searchParams.get('next'))

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, request.nextUrl.origin))
  }

  const signIn = new URL('/sign-in', request.nextUrl.origin)
  signIn.searchParams.set('error', 'callback')
  signIn.searchParams.set('next', next)
  return NextResponse.redirect(signIn)
}
