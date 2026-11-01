import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { handleStripeWebhook, type WebhookStripe } from '../../src/lib/billing/webhook'
import { withDb } from './local-db'
import { adminClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// PRD US-11.1 AC-7, through the real webhook handler and reserve_pages, the check submit-document
// makes on every upload: pages used in a month stay counted when the plan changes, so a workspace
// that drops to Free over 20 pages uploads nothing more until the next month; a workspace that
// moves to Pro has the 500 allowance on its next upload.

const SECRET = 'whsec_local_test_only'
const MONTH = "date_trunc('month', now() at time zone 'utc')::date"

async function deliver(type: string, subscription: Record<string, unknown>) {
  // customer.subscription.updated retrieves the current subscription: here, the one the event carries.
  const stripe = { subscriptions: { retrieve: async () => subscription } } as unknown as WebhookStripe
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', type, data: { object: subscription } })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET })
  const result = await handleStripeWebhook(payload, signature, { admin: adminClient, stripe: () => stripe, secret: () => SECRET })
  expect(result.status).toBe(200)
}

function subscription(ws: string, status: string, id = `sub_${randomUUID()}`) {
  return {
    id,
    object: 'subscription',
    customer: `cus_${randomUUID()}`,
    status,
    cancel_at_period_end: false,
    metadata: { workspace_id: ws },
    items: { object: 'list', data: [{ id: 'si_1', current_period_end: 1_900_000_000 }] },
  }
}

async function setPagesUsed(ws: string, pages: number) {
  await withDb((db) =>
    db.query(
      `insert into public.page_usage (workspace_id, period_start, pages_used) values ($1, ${MONTH}, $2)
       on conflict (workspace_id, period_start) do update set pages_used = excluded.pages_used`,
      [ws, pages],
    ),
  )
}

async function pagesUsed(ws: string): Promise<number> {
  const { rows } = await withDb((db) =>
    db.query<{ pages_used: number }>(`select pages_used from public.page_usage where workspace_id = $1 and period_start = ${MONTH}`, [ws]),
  )
  return rows[0].pages_used
}

/** One further upload of a one-page document, as submit-document reserves it. */
async function uploadOnePage(user: TestUser, ws: string) {
  const { id } = await createDocument(user, ws)
  await withDb((db) => db.query('update public.documents set page_count = 1 where id = $1', [id]))
  const { data, error } = await adminClient().rpc('reserve_pages', { document_id: id })
  expect(error).toBeNull()
  return data as boolean
}

async function limit(user: TestUser, ws: string): Promise<number> {
  const { data, error } = await user.client.rpc('get_page_allowance', { ws }).single<{ workspace_limit: number }>()
  expect(error).toBeNull()
  return data!.workspace_limit
}

describe('US-11.1 AC-7: the allowance through a plan change', () => {
  it('refuses a further upload to a workspace that drops from Pro to Free with more than 20 pages used, and keeps them counted', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    const held = `sub_${randomUUID()}`
    await deliver('customer.subscription.updated', subscription(ws, 'active', held))
    await setPagesUsed(ws, 30)
    expect(await limit(user, ws)).toBe(500)

    // The deletion names the subscription the workspace holds; one for another subscription is ignored.
    await deliver('customer.subscription.deleted', subscription(ws, 'canceled', held))

    expect(await limit(user, ws)).toBe(20)
    expect(await pagesUsed(ws)).toBe(30)
    expect(await uploadOnePage(user, ws)).toBe(false)
    expect(await pagesUsed(ws)).toBe(30)
  })

  it('gives a workspace that moves to Pro the 500 allowance on its next upload, with its pages still counted', async () => {
    const user = await signUp()
    const ws = await personalWorkspaceId(user)
    await setPagesUsed(ws, 20)
    expect(await uploadOnePage(user, ws)).toBe(false)

    await deliver('customer.subscription.updated', subscription(ws, 'active'))

    expect(await limit(user, ws)).toBe(500)
    expect(await pagesUsed(ws)).toBe(20)
    expect(await uploadOnePage(user, ws)).toBe(true)
    expect(await pagesUsed(ws)).toBe(21)
  })
})
