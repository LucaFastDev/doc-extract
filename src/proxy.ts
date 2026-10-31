import { NextResponse, type NextRequest } from 'next/server'
import { isPublicPath, REQUEST_PATH_HEADER, signInUrl } from '@/lib/auth/paths'
import { updateSession } from '@/lib/supabase/proxy'

// Only these requests are redirected. A 307 makes the browser repeat any other request, a server
// action's POST among them, against /sign-in, which answers with a page the caller cannot read.
const PAGE_LOADS = ['GET', 'HEAD']

// Next.js 16's proxy (formerly middleware, ARCHITECTURE.md section 6.2): refreshes the session
// cookie on every request, and sends a signed-out visitor who loads any page outside the public
// list to /sign-in?next=<path> (OQ-34). Pages and server actions still check the user themselves,
// sending a signed-out visitor to sign-in, and RLS decides what they read.
export async function proxy(request: NextRequest) {
  request.headers.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`)
  const { response, user } = await updateSession(request)

  if (!user && PAGE_LOADS.includes(request.method) && !isPublicPath(request.nextUrl.pathname)) {
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
