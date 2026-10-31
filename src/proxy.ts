import { NextResponse, type NextRequest } from 'next/server'
import { isPublicPath, signInUrl } from '@/lib/auth/paths'
import { updateSession } from '@/lib/supabase/proxy'

// Next.js 16's proxy (formerly middleware, ARCHITECTURE.md section 6.2): refreshes the session
// cookie on every request, and sends a signed-out visitor of any page outside the public list to
// /sign-in?next=<path> (OQ-34). Pages and server actions still check the user themselves, and RLS
// decides what they read.
export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request)

  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(signInUrl(request.nextUrl))
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie)
    return redirect
  }

  return response
}

export const config = {
  // Every path but static files and images.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
