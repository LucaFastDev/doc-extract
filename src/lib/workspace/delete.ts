import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { DELETE_FAILED } from '../account/memberships'

// Deleting a workspace (ARCHITECTURE.md section 6.2, PRD US-18.1, OQ-17, OQ-20, OQ-30, issue #61
// rulings 1 to 4), behind DELETE /api/workspaces/[id] and DELETE /api/account. The caller's client
// checks who may; the service-role client does the rest, in an order that leaves a workspace that
// can be deleted again wherever it stops: Stripe, Storage, held pages, then the row, whose delete
// cascades to everything else of the workspace. tests/access/deletion.test.ts runs this with real
// clients and a fake Stripe.

export type CancelStripe = Pick<Stripe, 'subscriptions'>

export interface DeleteWorkspaceDeps {
  /** The server client, as the signed-in caller. */
  asCaller: SupabaseClient
  /** The service-role client. */
  admin: () => SupabaseClient
  /** Called only for a workspace with a subscription, so the rest works with every Stripe variable unset. */
  stripe: () => CancelStripe
}

export interface DeleteWorkspaceResult {
  status: 204 | 401 | 403 | 404 | 500
  error?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Objects per Storage call, and documents per read of the held pages. */
const BATCH_SIZE = 100

/** The statuses in which a document's pages are held, not yet used (ruling 4). */
const HOLDING_PAGES = ['uploading', 'queued', 'waiting_budget', 'processing']

/** Stripe answered that there is no such subscription, or that it is already cancelled (ruling 2). */
function subscriptionAlreadyGone(error: unknown): boolean {
  const { type, code, statusCode, message } = error as { type?: unknown; code?: unknown; statusCode?: unknown; message?: unknown }
  if (type !== 'StripeInvalidRequestError') return false
  if (code === 'resource_missing' || statusCode === 404) return true
  return typeof message === 'string' && /cancell?ed/i.test(message)
}

/** Cancels at once, whatever the subscription's status; the Stripe customer stays. */
async function cancelSubscription(id: string, service: SupabaseClient, stripe: () => CancelStripe) {
  const { data, error } = await service.from('workspaces').select('stripe_subscription_id').eq('id', id).single<{ stripe_subscription_id: string | null }>()
  if (error) throw error
  if (!data.stripe_subscription_id) return
  try {
    await stripe().subscriptions.cancel(data.stripe_subscription_id)
  } catch (cancelError) {
    if (!subscriptionAlreadyGone(cancelError)) throw cancelError
  }
}

/** Adds what is under the folder to the batch, folders included, stopping when the batch is full. */
async function collectObjects(bucket: ReturnType<SupabaseClient['storage']['from']>, folder: string, batch: string[]) {
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const { data, error } = await bucket.list(folder, { limit: BATCH_SIZE, offset })
    if (error) throw error
    for (const entry of data) {
      if (batch.length >= BATCH_SIZE) return
      const path = `${folder}/${entry.name}`
      // The Storage API lists a folder as an entry with no id.
      if (entry.id) batch.push(path)
      else await collectObjects(bucket, path, batch)
    }
    if (data.length < BATCH_SIZE) return
  }
}

/**
 * Removes every object really under {id}/ in the documents bucket, not only the documents' paths,
 * because a file can outlive its row (ruling 3). Each round lists up to one batch and removes it,
 * until a listing finds nothing, so a run that is cut short has made progress and the next one
 * goes on from there (ARCHITECTURE.md section 14).
 */
async function removeObjects(id: string, service: SupabaseClient) {
  const bucket = service.storage.from('documents')
  for (;;) {
    const batch: string[] = []
    await collectObjects(bucket, id, batch)
    if (batch.length === 0) return
    const { data, error } = await bucket.remove(batch)
    if (error) throw error
    // No error and nothing removed would list the same objects for ever.
    if (data.length === 0) throw new Error(`Storage removed none of ${batch.length} objects.`)
  }
}

/**
 * Gives back the pages held by documents that will now never run, so a co-member's lifetime pages
 * do not stay used for them (ruling 4). Pages already used stay used, and release_pages gives a
 * document's pages back only once, however many runs it takes.
 */
async function releaseHeldPages(id: string, service: SupabaseClient) {
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const { data, error } = await service
      .from('documents')
      .select('id')
      .eq('workspace_id', id)
      .eq('pages_reserved', true)
      .in('status', HOLDING_PAGES)
      .gt('id', after)
      .order('id')
      .limit(BATCH_SIZE)
      .returns<{ id: string }[]>()
    if (error) throw error
    if (data.length === 0) return
    for (const doc of data) {
      const released = await service.rpc('release_pages', { document_id: doc.id })
      if (released.error) throw released.error
    }
    after = data[data.length - 1].id
  }
}

/**
 * Everything but the check of who may: the caller has done that, by is_owner for a workspace or
 * by being its one member for an account. Throws at the first failure, leaving the row.
 */
export async function removeWorkspace(id: string, { admin, stripe }: Pick<DeleteWorkspaceDeps, 'admin' | 'stripe'>): Promise<void> {
  const service = admin()
  await cancelSubscription(id, service, stripe)
  await removeObjects(id, service)
  await releaseHeldPages(id, service)
  const { error } = await service.from('workspaces').delete().eq('id', id)
  if (error) throw error
}

/** Only an owner may delete a workspace; nothing changes for anyone else. */
export async function deleteWorkspace(id: string, { asCaller, admin, stripe }: DeleteWorkspaceDeps): Promise<DeleteWorkspaceResult> {
  try {
    const {
      data: { user },
    } = await asCaller.auth.getUser()
    if (!user) return { status: 401, error: 'Sign in to delete a workspace.' }

    const notFound: DeleteWorkspaceResult = { status: 404, error: 'This workspace does not exist.' }
    if (!UUID.test(id)) return notFound
    const member = await asCaller.rpc('is_member', { ws: id })
    if (member.error) throw member.error
    if (member.data !== true) return notFound
    const owner = await asCaller.rpc('is_owner', { ws: id })
    if (owner.error) throw owner.error
    if (owner.data !== true) return { status: 403, error: 'Only an owner of this workspace can delete it.' }

    await removeWorkspace(id, { admin, stripe })
    return { status: 204 }
  } catch (error) {
    console.error('Workspace', id, 'could not be deleted.', error)
    return { status: 500, error: DELETE_FAILED }
  }
}
