import 'server-only'
import { stripeKeyProblem } from '@/lib/stripe-key'

// Runs once when a server instance starts, before it handles a request (PRD US-11.1 AC-4, Lead
// ruling 1 on #50): the app never creates a real charge, so a key that is not a test key stops the
// server. An unset key does not, because the demo and the landing page run without Stripe.
export function register() {
  if (stripeKeyProblem(process.env.STRIPE_SECRET_KEY) === 'not_test') {
    throw new Error('STRIPE_SECRET_KEY does not start with sk_test_. This app runs in Stripe test mode only.')
  }
}
