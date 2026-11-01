import 'server-only'
import Stripe from 'stripe'
import { stripeKeyProblem } from './stripe-key'

// The only place that creates a Stripe client (Lead ruling 1 on #50). Nothing here runs at import:
// the build and the pages that never touch billing work with every Stripe variable unset.

/** The API version stripe@23.1.0 is typed against; the response shapes in src/lib/billing/ rest on it. */
export const STRIPE_API_VERSION = '2026-10-28.endive'

/** A client for Stripe test mode. Throws when STRIPE_SECRET_KEY is unset or not a test key. */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  const problem = stripeKeyProblem(key)
  if (problem === 'unset') throw new Error('STRIPE_SECRET_KEY is not set.')
  if (problem === 'not_test') {
    throw new Error('STRIPE_SECRET_KEY does not start with sk_test_. This app runs in Stripe test mode only.')
  }
  return new Stripe(key!, { apiVersion: STRIPE_API_VERSION })
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

/** The test-mode price of the Pro plan. */
export function stripePricePro(): string {
  return required('STRIPE_PRICE_PRO', process.env.STRIPE_PRICE_PRO)
}

/** The signing secret of the webhook endpoint. */
export function stripeWebhookSecret(): string {
  return required('STRIPE_WEBHOOK_SECRET', process.env.STRIPE_WEBHOOK_SECRET)
}
