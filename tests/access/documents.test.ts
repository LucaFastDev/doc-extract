import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { addMember, anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// documents and create_document (ARCHITECTURE.md sections 4.1, 4.2 and 4.3, PRD US-1.1 and
// US-10.1): members see and create documents only in their own workspace; nobody changes a
// document's status or page count from the client.

interface DocumentRow {
  workspace_id: string
  uploaded_by: string | null
  status: string
  file_name: string
  mime_type: string
  byte_size: string
  storage_path: string
  page_count: number | null
}

async function documentRow(id: string): Promise<DocumentRow | undefined> {
  return withDb(async (db) => {
    const { rows } = await db.query<DocumentRow>(
      `select workspace_id, uploaded_by, status, file_name, mime_type, byte_size, storage_path, page_count
       from public.documents where id = $1`,
      [id],
    )
    return rows[0]
  })
}

async function documentCount(ws: string): Promise<number> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from public.documents where workspace_id = $1', [
      ws,
    ])
    return rows[0].n
  })
}

describe('create_document', () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let ws: string

  beforeAll(async () => {
    owner = await signUp()
    member = await signUp()
    stranger = await signUp()
    ws = await personalWorkspaceId(owner)
    await addMember(ws, member, 'member')
  })

  it('lets a member create a document, uploading, with its storage path under the workspace', async () => {
    const { data, error } = await member.client
      .rpc('create_document', { ws, file_name: 'Invoice 7.pdf', mime_type: 'application/pdf', byte_size: 2048 })
      .single<{ id: string; storage_path: string }>()
    expect(error).toBeNull()
    expect(data!.storage_path).toBe(`${ws}/${data!.id}/original`)
    expect(await documentRow(data!.id)).toEqual({
      workspace_id: ws,
      uploaded_by: member.id,
      status: 'uploading',
      file_name: 'Invoice 7.pdf',
      mime_type: 'application/pdf',
      byte_size: '2048',
      storage_path: `${ws}/${data!.id}/original`,
      page_count: null,
    })
  })

  // Issue #28: images at most 7,500,000 bytes, PDFs at most 10 MB.
  it('accepts a JPEG, PNG and WebP of exactly 7,500,000 bytes, and a PDF of exactly 10 MB', async () => {
    for (const mime_type of ['image/jpeg', 'image/png', 'image/webp']) {
      await createDocument(owner, ws, { file_name: 'photo', mime_type, byte_size: 7_500_000 })
    }
    await createDocument(owner, ws, { file_name: 'scan.pdf', mime_type: 'application/pdf', byte_size: 10 * 1024 * 1024 })
  })

  it('refuses a JPEG, PNG or WebP over 7,500,000 bytes, naming the image limit, and creates nothing', async () => {
    const before = await documentCount(ws)
    for (const mime_type of ['image/jpeg', 'image/png', 'image/webp']) {
      for (const byte_size of [7_500_001, 10 * 1024 * 1024]) {
        const { data, error } = await owner.client.rpc('create_document', { ws, file_name: 'photo', mime_type, byte_size })
        expect(data, `${mime_type} ${byte_size}`).toBeNull()
        expect(error?.code).toBe('22023')
        expect(error?.message).toBe('an image must be at most 7.5 MB')
      }
    }
    expect(await documentCount(ws)).toBe(before)
  })

  it('accepts a PDF over 7.5 MB', async () => {
    await createDocument(owner, ws, { file_name: 'scan.pdf', mime_type: 'application/pdf', byte_size: 7_500_001 })
  })

  it('refuses a non-member and anon, and creates nothing', async () => {
    const before = await documentCount(ws)
    for (const client of [stranger.client, anonClient()]) {
      const { data, error } = await client.rpc('create_document', {
        ws,
        file_name: 'x.pdf',
        mime_type: 'application/pdf',
        byte_size: 10,
      })
      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    }
    expect(await documentCount(ws)).toBe(before)
  })

  it('refuses another type, a file over 10 MB, an empty file and a blank name', async () => {
    const before = await documentCount(ws)
    for (const [file_name, mime_type, byte_size] of [
      ['x.gif', 'image/gif', 10],
      ['x.txt', 'text/plain', 10],
      ['x.pdf', 'application/pdf', 10 * 1024 * 1024 + 1],
      ['x.pdf', 'application/pdf', 0],
      ['  ', 'application/pdf', 10],
    ] as const) {
      const { error } = await owner.client.rpc('create_document', { ws, file_name, mime_type, byte_size })
      expect(error?.code).toBe('22023')
    }
    expect(await documentCount(ws)).toBe(before)
  })
})

describe('documents', () => {
  let ownerA: TestUser
  let memberA: TestUser
  let ownerB: TestUser
  let wsA: string
  let docA: string

  beforeAll(async () => {
    ownerA = await signUp()
    memberA = await signUp()
    ownerB = await signUp()
    wsA = await personalWorkspaceId(ownerA)
    await addMember(wsA, memberA, 'member')
    docA = (await createDocument(ownerA, wsA)).id
    await createDocument(ownerB, await personalWorkspaceId(ownerB))
  })

  it('shows members of the workspace its documents, and only those', async () => {
    for (const user of [ownerA, memberA]) {
      const { data, error } = await user.client.from('documents').select('id, workspace_id')
      expect(error).toBeNull()
      expect(data).toEqual([{ id: docA, workspace_id: wsA }])
    }
  })

  it('shows a non-member and anon none of them', async () => {
    const { data } = await ownerB.client.from('documents').select('id').eq('workspace_id', wsA)
    expect(data).toEqual([])
    const anon = await anonClient().from('documents').select('id')
    expect(anon.data ?? []).toEqual([])
  })

  it('has no client insert or delete, not even for a member', async () => {
    const insert = await ownerA.client.from('documents').insert({
      workspace_id: wsA,
      status: 'queued',
      file_name: 'direct.pdf',
      mime_type: 'application/pdf',
      byte_size: 10,
      page_count: 1,
    })
    expect(insert.error?.code).toBe('42501')
    const remove = await ownerA.client.from('documents').delete().eq('id', docA)
    expect(remove.error?.code).toBe('42501')
    expect(await documentRow(docA)).toBeDefined()
    expect(await documentCount(wsA)).toBe(1)
  })

  it('lets no client change a document’s status, page count or anything else', async () => {
    for (const change of [{ status: 'queued' }, { page_count: 1 }, { pages_reserved: true }, { file_name: 'y.pdf' }]) {
      for (const client of [ownerA.client, memberA.client, ownerB.client, anonClient()]) {
        const { data, error } = await client.from('documents').update(change).eq('id', docA).select('id')
        expect(data ?? []).toEqual([])
        expect(error?.code).toBe('42501')
      }
    }
    expect(await documentRow(docA)).toMatchObject({ status: 'uploading', page_count: null, file_name: 'invoice.pdf' })
  })
})

describe('documents in Realtime', () => {
  let ownerA: TestUser
  let ownerB: TestUser
  let wsA: string
  let docA: string

  beforeAll(async () => {
    ownerA = await signUp()
    ownerB = await signUp()
    wsA = await personalWorkspaceId(ownerA)
    docA = (await createDocument(ownerA, wsA)).id
  })

  async function subscribe(user: TestUser, ws: string, received: unknown[]) {
    const channel = user.client
      .channel(`documents-${ws}-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents', filter: `workspace_id=eq.${ws}` }, (p) =>
        received.push(p.new),
      )
    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err ?? new Error(status))
      })
    })
    return channel
  }

  it('sends a status change to members of the workspace, and never to anyone else', async () => {
    const toMember: { id?: string; status?: string }[] = []
    const toStranger: unknown[] = []
    const member = await subscribe(ownerA, wsA, toMember)
    const stranger = await subscribe(ownerB, wsA, toStranger)

    // Realtime starts sending a channel's changes a moment after it reports SUBSCRIBED, and longer
    // just after `supabase db reset` restarts it, so the change is repeated until one arrives.
    const deadline = Date.now() + 20_000
    for (let n = 1; !toMember.some((d) => d.id === docA && d.status === 'queued') && Date.now() < deadline; n++) {
      await withDb((db) => db.query("update public.documents set status = 'queued', page_count = $2 where id = $1", [docA, n]))
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(toMember.map((d) => [d.id, d.status])).toContainEqual([docA, 'queued'])

    await new Promise((r) => setTimeout(r, 1500))
    expect(toStranger).toEqual([])
    await ownerA.client.removeChannel(member)
    await ownerB.client.removeChannel(stranger)
  }, 30_000)
})
