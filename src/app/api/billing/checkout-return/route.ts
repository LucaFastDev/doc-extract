import { checkCheckoutReturn } from '@/lib/billing/sessions'
import { getStripe } from '@/lib/stripe'
import { createClient } from '@/lib/supabase/server'

// POST /api/billing/checkout-return (ARCHITECTURE.md section 6.2, issue 87): the billing page sends
// the workspace it is showing and the session its return names, and acts on the return only when this
// answers paid.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const result = await checkCheckoutReturn(body?.workspaceId, body?.sessionId, {
    asCaller: await createClient(),
    stripe: getStripe,
  })
  return Response.json(result.status === 200 ? { paid: result.paid } : { error: result.error }, { status: result.status })
}
