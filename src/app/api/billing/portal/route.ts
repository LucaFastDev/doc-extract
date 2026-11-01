import { createPortal } from '@/lib/billing/sessions'
import { billingUrl } from '@/lib/site'
import { getStripe } from '@/lib/stripe'
import { createClient } from '@/lib/supabase/server'

// POST /api/billing/portal (ARCHITECTURE.md section 6.2, OQ-37): the "Manage or cancel" button sends
// the workspace it is showing, and is sent on to the URL this returns.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const result = await createPortal(body?.workspaceId, {
    asCaller: await createClient(),
    stripe: getStripe,
    returnUrl: () => billingUrl(),
  })
  return Response.json(result.status === 200 ? { url: result.url } : { error: result.error }, { status: result.status })
}
