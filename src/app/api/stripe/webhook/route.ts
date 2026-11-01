import { handleStripeWebhook } from '@/lib/billing/webhook'
import { getStripe, stripeWebhookSecret } from '@/lib/stripe'
import { createServiceRoleClient } from '@/lib/supabase/server'

// POST /api/stripe/webhook (ARCHITECTURE.md section 6.2): no session, public to the proxy, and
// authenticated by Stripe's signature over the raw body.
export async function POST(request: Request) {
  const result = await handleStripeWebhook(await request.text(), request.headers.get('stripe-signature'), {
    admin: createServiceRoleClient,
    stripe: getStripe,
    secret: stripeWebhookSecret,
  })
  return Response.json(result.status === 200 ? { received: true } : { error: result.error }, { status: result.status })
}
