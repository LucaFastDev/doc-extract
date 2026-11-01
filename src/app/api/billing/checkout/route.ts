import { createCheckout } from '@/lib/billing/sessions'
import { billingUrl } from '@/lib/site'
import { getStripe, stripePricePro } from '@/lib/stripe'
import { createClient } from '@/lib/supabase/server'

// POST /api/billing/checkout (ARCHITECTURE.md section 6.2): the Upgrade button sends the workspace
// it is showing, and is sent on to the URL this returns. Success and cancel both come back to the
// billing page (Lead ruling 6 on #50).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const result = await createCheckout(body?.workspaceId, {
    asCaller: await createClient(),
    stripe: getStripe,
    settings: () => ({ priceId: stripePricePro(), successUrl: billingUrl('success'), cancelUrl: billingUrl() }),
  })
  return Response.json(result.status === 200 ? { url: result.url } : { error: result.error }, { status: result.status })
}
