import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'

// Opening Stripe Checkout and the customer portal (ARCHITECTURE.md section 6.2, PRD US-11.1, OQ-20,
// OQ-24, OQ-37), behind POST /api/billing/checkout and /api/billing/portal. The caller's client
// reads the workspace and checks is_owner; nothing reaches Stripe, or reads a Stripe setting, until
// those pass. tests/access/billing-routes.test.ts runs this with real users and a fake Stripe.

export type CheckoutStripe = Pick<Stripe, 'checkout'>
export type PortalStripe = Pick<Stripe, 'billingPortal'>

export interface CheckoutSettings {
  priceId: string
  successUrl: string
  cancelUrl: string
}

export interface BillingResult {
  status: 200 | 401 | 403 | 409 | 500
  url?: string
  error?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface OwnedWorkspace {
  id: string
  plan: string
  stripe_customer_id: string | null
}

/** The workspace, when the caller is signed in and owns it; otherwise the refusal to answer with. */
async function ownedWorkspace(workspaceId: unknown, asCaller: SupabaseClient): Promise<OwnedWorkspace | BillingResult> {
  const {
    data: { user },
  } = await asCaller.auth.getUser()
  if (!user) return { status: 401, error: 'Sign in to manage billing.' }

  const notOwner: BillingResult = { status: 403, error: 'Only an owner of this workspace can manage billing.' }
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) return notOwner
  const owner = await asCaller.rpc('is_owner', { ws: workspaceId })
  if (owner.error) throw owner.error
  if (owner.data !== true) return notOwner

  const { data, error } = await asCaller
    .from('workspaces')
    .select('id, plan, stripe_customer_id')
    .eq('id', workspaceId)
    .single<OwnedWorkspace>()
  if (error) throw error
  return data
}

/** A Checkout session in subscription mode for Pro, with no trial, and the URL to send the browser to. */
export async function createCheckout(
  workspaceId: unknown,
  deps: { asCaller: SupabaseClient; stripe: () => CheckoutStripe; settings: () => CheckoutSettings },
): Promise<BillingResult> {
  try {
    const workspace = await ownedWorkspace(workspaceId, deps.asCaller)
    if ('status' in workspace) return workspace
    if (workspace.plan === 'pro') return { status: 409, error: 'This workspace is already on Pro.' }

    const { priceId, successUrl, cancelUrl } = deps.settings()
    const metadata = { workspace_id: workspace.id }
    const session = await deps.stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      ...(workspace.stripe_customer_id ? { customer: workspace.stripe_customer_id } : {}),
      metadata,
      subscription_data: { metadata },
      success_url: successUrl,
      cancel_url: cancelUrl,
    })
    if (!session.url) throw new Error('Stripe returned a Checkout session with no URL.')
    return { status: 200, url: session.url }
  } catch (error) {
    console.error('A Checkout session could not be created.', error)
    return { status: 500, error: 'Checkout could not be opened. Try again.' }
  }
}

/** A customer portal session for the workspace's Stripe customer, and the URL to send the browser to. */
export async function createPortal(
  workspaceId: unknown,
  deps: { asCaller: SupabaseClient; stripe: () => PortalStripe; returnUrl: () => string },
): Promise<BillingResult> {
  try {
    const workspace = await ownedWorkspace(workspaceId, deps.asCaller)
    if ('status' in workspace) return workspace
    if (!workspace.stripe_customer_id) return { status: 409, error: 'This workspace has no Stripe customer yet.' }

    const session = await deps.stripe().billingPortal.sessions.create({
      customer: workspace.stripe_customer_id,
      return_url: deps.returnUrl(),
    })
    return { status: 200, url: session.url }
  } catch (error) {
    console.error('A customer portal session could not be created.', error)
    return { status: 500, error: 'The customer portal could not be opened. Try again.' }
  }
}
