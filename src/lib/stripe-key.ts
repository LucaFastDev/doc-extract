// The one check behind both refusals of a live key (PRD US-11.1 AC-4, Lead ruling 1 on #50):
// src/lib/stripe.ts refuses to make a client, and src/instrumentation.ts refuses to start the
// server. Plain, with no imports, so the server-start check loads no Stripe code.

export type StripeKeyProblem = 'unset' | 'not_test'

/** What is wrong with a STRIPE_SECRET_KEY value, or null for a test key. */
export function stripeKeyProblem(key: string | undefined): StripeKeyProblem | null {
  if (!key) return 'unset'
  return key.startsWith('sk_test_') ? null : 'not_test'
}
