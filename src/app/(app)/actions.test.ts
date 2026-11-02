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

// Issue #80 criterion 1: a database error is not blamed on the role.
describe('the refusals of a rename', () => {
  beforeEach(() => {
    user = { id: 'u1' }
    requestPath = '/documents'
    update.mockReset()
  })

  it('says the workspace could not be renamed when the update returns an error', async () => {
    update.mockReturnValue({ eq: () => ({ select: async () => ({ data: null, error: { message: 'boom' } }) }) })
    expect(await renameWorkspace({}, form({ id: 'ws-1', name: 'New' }))).toEqual({
      error: 'The workspace could not be renamed. Try again.',
    })
  })

  it('says only an owner can rename when the update returns no error and no row', async () => {
    update.mockReturnValue({ eq: () => ({ select: async () => ({ data: [], error: null }) }) })
    expect(await renameWorkspace({}, form({ id: 'ws-1', name: 'New' }))).toEqual({
      error: 'Only an owner can rename this workspace.',
    })
  })
})

// Issue #69 criterion 5: the count is of code points after the trim, as char_length counts, so 100
// emoji are within the limit though their length in JavaScript is 200.
describe('the 100-character limit on a workspace name', () => {
  const TOO_LONG = { error: 'Use 100 characters or fewer for the workspace name.' }
  const OVER = ['x'.repeat(101), `  ${'x'.repeat(101)}  `, '😀'.repeat(101)]
  const AT_LIMIT = [
    ['x'.repeat(100), 'x'.repeat(100)],
    [`  ${'x'.repeat(100)}  `, 'x'.repeat(100)],
    ['😀'.repeat(100), '😀'.repeat(100)],
  ]

  beforeEach(() => {
    user = { id: 'u1' }
    requestPath = '/documents'
    rpc.mockReset()
    update.mockReset()
    rpc.mockResolvedValue({ data: 'ws-new', error: null })
    update.mockReturnValue({ eq: () => ({ select: async () => ({ data: [{ id: 'ws-1' }], error: null }) }) })
  })

  it('create refuses over 100 before calling the database, and sends 100 on', async () => {
    for (const name of OVER) {
      expect(await createWorkspace({}, form({ name }))).toEqual(TOO_LONG)
    }
    expect(rpc).not.toHaveBeenCalled()

    for (const [name, trimmed] of AT_LIMIT) {
      expect(await createWorkspace({}, form({ name }))).toEqual({ ok: true })
      expect(rpc).toHaveBeenLastCalledWith('create_workspace', { name: trimmed })
    }
  })

  it('rename refuses over 100 before calling the database, without blaming the role, and sends 100 on', async () => {
    for (const name of OVER) {
      expect(await renameWorkspace({}, form({ id: 'ws-1', name }))).toEqual(TOO_LONG)
    }
    expect(update).not.toHaveBeenCalled()

    for (const [name, trimmed] of AT_LIMIT) {
      expect(await renameWorkspace({}, form({ id: 'ws-1', name }))).toEqual({ ok: true })
      expect(update).toHaveBeenLastCalledWith({ name: trimmed })
    }
  })
})
