import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteWorkspace, type CancelStripe } from './delete'

// DELETE /api/workspaces/[id] with fakes in place of Supabase and Stripe (issue #61 criterion 10,
// rulings 1 to 4): no Stripe network, and the order of the steps as a list. The fake Stripe client
// answers with the SDK's own error classes. tests/access/deletion.test.ts runs the same code with
// real clients against the local stack.

const WS = '11111111-1111-4111-8111-111111111111'
const SUB = 'sub_test_123'

interface FakeOptions {
  workspace?: Record<string, unknown>
  isMember?: boolean
  isOwner?: boolean
  signedIn?: boolean
  /** Object paths in the documents bucket. */
  objects?: string[]
  /** Ids of the documents the held-pages read finds. */
  held?: string[]
  listError?: boolean
  removeError?: boolean
  /** remove() reports success and removes nothing. */
  removeNothing?: boolean
  releaseError?: boolean
  rowError?: boolean
}

/** A SupabaseClient as far as the delete code uses it, keeping a list of what was asked of it. */
function fakeClients(o: FakeOptions = {}) {
  const steps: string[] = []
  const buckets: string[] = []
  const heldFilters: unknown[][] = []
  const removedBatches: string[][] = []
  const objects = new Set(o.objects ?? [])
  let held = [...(o.held ?? [])]

  const asCaller = {
    auth: {
      getUser: async () => ({ data: { user: o.signedIn === false ? null : { id: 'caller' } } }),
    },
    rpc: async (fn: string) => {
      if (fn === 'is_member') return { data: o.isMember ?? true, error: null }
      if (fn === 'is_owner') return { data: o.isOwner ?? true, error: null }
      throw new Error(`unexpected rpc ${fn}`)
    },
  } as unknown as SupabaseClient

  const storageBucket = {
    list: async (prefix: string, options: { limit: number; offset: number }) => {
      steps.push('list')
      if (o.listError) return { data: null, error: { message: 'list failed' } }
      const children = new Map<string, boolean>()
      for (const path of objects) {
        if (!path.startsWith(`${prefix}/`)) continue
        const [name, ...rest] = path.slice(prefix.length + 1).split('/')
        children.set(name, rest.length > 0)
      }
      const entries = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, folder]) => ({ name, id: folder ? null : `id-${name}` }))
      return { data: entries.slice(options.offset, options.offset + options.limit), error: null }
    },
    remove: async (paths: string[]) => {
      steps.push('remove')
      removedBatches.push(paths)
      if (o.removeError) return { data: null, error: { message: 'remove failed' } }
      if (o.removeNothing) return { data: [], error: null }
      for (const path of paths) objects.delete(path)
      return { data: paths.map((name) => ({ name })), error: null }
    },
  }

  /** A query builder: every filter returns it, and awaiting it gives the answer. */
  function query(answer: () => unknown, note?: (name: string, args: unknown[]) => void) {
    const builder: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'in', 'gt', 'order', 'limit', 'range', 'returns']) {
      builder[name] = (...args: unknown[]) => {
        note?.(name, args)
        return builder
      }
    }
    builder.single = async () => answer()
    builder.maybeSingle = async () => answer()
    builder.then = (resolve: (value: unknown) => unknown) => resolve(answer())
    return builder
  }

  const admin = {
    from: (table: string) => {
      if (table === 'workspaces') {
        return {
          select: () => query(() => ({ data: { stripe_subscription_id: null, ...o.workspace }, error: null })),
          delete: () =>
            query(() => {
              steps.push('delete row')
              return { error: o.rowError ? { message: 'row failed' } : null }
            }),
        }
      }
      if (table === 'documents') {
        return query(
          () => {
            const data = held.map((id) => ({ id }))
            held = []
            return { data, error: null }
          },
          (name, args) => {
            if (name === 'in' || name === 'eq') heldFilters.push(args)
          },
        )
      }
      throw new Error(`unexpected table ${table}`)
    },
    storage: {
      from: (bucket: string) => {
        buckets.push(bucket)
        return storageBucket
      },
    },
    rpc: async (fn: string, args: { document_id: string }) => {
      expect(fn).toBe('release_pages')
      steps.push(`release ${args.document_id}`)
      return { data: null, error: o.releaseError ? { message: 'release failed' } : null }
    },
  } as unknown as SupabaseClient

  return { asCaller, admin: () => admin, steps, buckets, objects, removedBatches, heldFilters }
}

function fakeStripe(cancel: (id: string) => Promise<unknown> = async () => ({ status: 'canceled' })) {
  const fn = vi.fn(cancel)
  const stripe = { subscriptions: { cancel: fn } } as unknown as CancelStripe
  return { factory: vi.fn(() => stripe), cancel: fn }
}

/** The SDK's error for a 4xx from Stripe's API, as the client would raise it. */
function invalidRequest(message: string, extra: { code?: string; statusCode?: number } = {}) {
  return new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message, ...extra })
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deleteWorkspace and Stripe', () => {
  it('never calls getStripe for a workspace with no subscription id', async () => {
    const clients = fakeClients({ workspace: { stripe_subscription_id: null } })
    const { factory } = fakeStripe()
    const result = await deleteWorkspace(WS, { ...clients, stripe: factory })
    expect(result.status).toBe(204)
    expect(factory).not.toHaveBeenCalled()
    expect(clients.steps).toContain('delete row')
  })

  it.each([
    ['active', { plan: 'pro', plan_cancel_at_period_end: false }],
    ['past_due', { plan: 'pro', plan_cancel_at_period_end: false }],
    ['set to end', { plan: 'pro', plan_cancel_at_period_end: true }],
    ['already free', { plan: 'free', plan_cancel_at_period_end: false }],
  ])('cancels a subscription at once, whatever its status: %s', async (_status, columns) => {
    const clients = fakeClients({ workspace: { stripe_subscription_id: SUB, ...columns } })
    const { factory, cancel } = fakeStripe()
    const result = await deleteWorkspace(WS, { ...clients, stripe: factory })
    expect(result.status).toBe(204)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith(SUB)
    expect(clients.steps).toContain('delete row')
  })

  it.each([
    ['the subscription does not exist', invalidRequest(`No such subscription: '${SUB}'`, { code: 'resource_missing', statusCode: 404 })],
    ['a 404 with no code', invalidRequest(`No such subscription: '${SUB}'`, { statusCode: 404 })],
    ['it is already cancelled', invalidRequest('A canceled subscription can only update its cancellation_details and metadata.', { statusCode: 400 })],
  ])('counts it as cancelled when Stripe answers that %s', async (_answer, error) => {
    const clients = fakeClients({ workspace: { stripe_subscription_id: SUB } })
    const { factory, cancel } = fakeStripe(async () => {
      throw error
    })
    const result = await deleteWorkspace(WS, { ...clients, stripe: factory })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(204)
    expect(clients.steps).toContain('delete row')
  })

  it.each([
    ['a connection failure', new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'Network down' })],
    ['a rate limit', new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'Too many requests' })],
    ['a server error', new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'Something went wrong' })],
    ['another invalid request', invalidRequest('Invalid API version', { statusCode: 400 })],
    ['a plain error', new Error('boom')],
  ])('answers 500 and removes nothing on %s', async (_name, error) => {
    const clients = fakeClients({ workspace: { stripe_subscription_id: SUB }, objects: [`${WS}/doc/original`], held: ['doc'] })
    const { factory, cancel } = fakeStripe(async () => {
      throw error
    })
    const result = await deleteWorkspace(WS, { ...clients, stripe: factory })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(500)
    expect(clients.steps).toEqual([])
    expect(clients.objects.size).toBe(1)
  })

  it('answers 500 and removes nothing when getStripe throws, as with every Stripe variable unset', async () => {
    const clients = fakeClients({ workspace: { stripe_subscription_id: SUB }, objects: [`${WS}/doc/original`] })
    const stripe = vi.fn((): CancelStripe => {
      throw new Error('STRIPE_SECRET_KEY is not set.')
    })
    const result = await deleteWorkspace(WS, { ...clients, stripe })
    expect(stripe).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(500)
    expect(result.error).not.toContain('STRIPE_SECRET_KEY')
    expect(clients.steps).toEqual([])
  })
})

describe('deleteWorkspace, who may', () => {
  it('answers 401 with no session, whatever the id', async () => {
    for (const id of [WS, 'not-a-uuid']) {
      const clients = fakeClients({ signedIn: false })
      const { factory } = fakeStripe()
      expect((await deleteWorkspace(id, { ...clients, stripe: factory })).status).toBe(401)
      expect(clients.steps).toEqual([])
      expect(factory).not.toHaveBeenCalled()
    }
  })

  it('answers 404 to an id that is not a UUID and to someone who is not a member', async () => {
    for (const [id, isMember] of [
      ['not-a-uuid', true],
      [WS, false],
    ] as const) {
      const clients = fakeClients({ isMember, isOwner: false })
      const { factory } = fakeStripe()
      expect((await deleteWorkspace(id, { ...clients, stripe: factory })).status).toBe(404)
      expect(clients.steps).toEqual([])
      expect(factory).not.toHaveBeenCalled()
    }
  })

  it('answers 403 to a member who is not an owner', async () => {
    const clients = fakeClients({ isOwner: false, workspace: { stripe_subscription_id: SUB } })
    const { factory } = fakeStripe()
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(403)
    expect(clients.steps).toEqual([])
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('deleteWorkspace, the order and the files', () => {
  it('goes Stripe, Storage, held pages, then the row', async () => {
    const clients = fakeClients({ workspace: { stripe_subscription_id: SUB }, objects: [`${WS}/a/original`], held: ['a'] })
    const { factory, cancel } = fakeStripe(async () => {
      clients.steps.push('cancel')
      return {}
    })
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(204)
    expect(cancel).toHaveBeenCalled()
    expect(clients.steps.filter((s) => s !== 'list')).toEqual(['cancel', 'remove', 'release a', 'delete row'])
  })

  it('removes what is really under the folder, nested too, in batches of at most 100 until the listing is empty', async () => {
    const objects = [
      ...Array.from({ length: 150 }, (_, i) => `${WS}/doc-${String(i).padStart(3, '0')}/original`),
      ...Array.from({ length: 120 }, (_, i) => `${WS}/left/behind/file-${String(i).padStart(3, '0')}.pdf`),
      `${WS}/top-level.pdf`,
    ]
    const clients = fakeClients({ objects })
    const { factory } = fakeStripe()
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(204)
    expect(clients.objects.size).toBe(0)
    expect(clients.removedBatches.length).toBeGreaterThanOrEqual(3)
    for (const batch of clients.removedBatches) expect(batch.length).toBeLessThanOrEqual(100)
    expect(clients.removedBatches.flat().sort()).toEqual([...objects].sort())
    expect(new Set(clients.buckets)).toEqual(new Set(['documents']))
  })

  it('stops with 500 and keeps the row on a listing error', async () => {
    const clients = fakeClients({ objects: [`${WS}/a/original`], listError: true })
    const { factory } = fakeStripe()
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(500)
    expect(clients.steps).toEqual(['list'])
  })

  it('stops with 500 and keeps the row on a removal error', async () => {
    const clients = fakeClients({ objects: [`${WS}/a/original`], held: ['a'], removeError: true })
    const { factory } = fakeStripe()
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(500)
    expect(clients.steps.at(-1)).toBe('remove')
    expect(clients.steps).not.toContain('delete row')
    expect(clients.steps.some((s) => s.startsWith('release'))).toBe(false)
  })

  it('stops with 500 rather than listing for ever when a removal removes nothing', async () => {
    const clients = fakeClients({ objects: [`${WS}/a/original`], removeNothing: true })
    const { factory } = fakeStripe()
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(500)
    expect(clients.removedBatches).toHaveLength(1)
    expect(clients.steps).not.toContain('delete row')
  })

  it('releases pages only for documents holding them in a status that has not used them, and stops with 500 on an error', async () => {
    const clients = fakeClients({ held: ['a', 'b'], releaseError: true })
    const { factory } = fakeStripe()
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(500)
    expect(clients.steps).toEqual(expect.arrayContaining(['release a']))
    expect(clients.steps).not.toContain('release b')
    expect(clients.steps).not.toContain('delete row')
    expect(clients.heldFilters).toEqual(
      expect.arrayContaining([
        ['workspace_id', WS],
        ['pages_reserved', true],
        ['status', ['uploading', 'queued', 'waiting_budget', 'processing']],
      ]),
    )
  })

  it('answers 500 when the row cannot be deleted', async () => {
    const clients = fakeClients({ rowError: true })
    const { factory } = fakeStripe()
    expect((await deleteWorkspace(WS, { ...clients, stripe: factory })).status).toBe(500)
    expect(clients.steps).toContain('delete row')
  })
})
