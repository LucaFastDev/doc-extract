import { beforeEach, describe, expect, it, vi } from 'vitest'

let user: { id: string } | null = null
let requestPath: string | null = null
const rpc = vi.fn()
const update = vi.fn()

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`)
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc,
    from: () => ({ update }),
  }),
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: vi.fn() }),
  headers: async () => new Headers(requestPath === null ? {} : { 'x-request-path': requestPath }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { createWorkspace, renameWorkspace, switchWorkspace } = await import('./actions')

function form(fields: Record<string, string>) {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

async function redirectOf(action: Promise<unknown>) {
  const error = await action.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Redirected)
  return new URL((error as Redirected).to, 'http://site.test')
}

describe('workspace actions after the session has ended', () => {
  beforeEach(() => {
    user = null
    requestPath = '/documents?status=failed'
    rpc.mockReset()
    update.mockReset()
  })

  it.each([
    ['switch', () => switchWorkspace('ws-1')],
    ['create', () => createWorkspace({}, form({ name: 'New' }))],
    ['rename', () => renameWorkspace({}, form({ id: 'ws-1', name: 'New' }))],
  ])('%s sends the visitor to sign-in with the page as next, and changes nothing', async (_name, run) => {
    const url = await redirectOf(run())
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('next')).toBe('/documents?status=failed')
    expect(rpc).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it.each([null, '//evil.example/x'])('passes the page through safeNextPath, so %s gives the document list', async (path) => {
    requestPath = path
    const url = await redirectOf(switchWorkspace('ws-1'))
    expect(url.origin).toBe('http://site.test')
    expect(url.searchParams.get('next')).toBe('/documents')
  })

  it('runs as the user while the session lasts', async () => {
    user = { id: 'u1' }
    rpc.mockResolvedValue({ data: false, error: null })
    await switchWorkspace('ws-1')
    expect(rpc).toHaveBeenCalledWith('is_member', { ws: 'ws-1' })
  })
})
