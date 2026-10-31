import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { addMember, anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// The documents bucket and its policies (ARCHITECTURE.md section 5, OQ-4): private; a member
// uploads only to the path create_document gave a document still uploading, and reads only their
// workspace's objects; nobody updates or deletes from the client; a non-member and anon reach
// nothing.

const PDF = new TextEncoder().encode('%PDF-1.7\n%test\n')
const options = { contentType: 'application/pdf', upsert: false }

async function objectExists(path: string): Promise<boolean> {
  return withDb(async (db) => {
    const { rowCount } = await db.query("select 1 from storage.objects where bucket_id = 'documents' and name = $1", [path])
    return rowCount === 1
  })
}

describe('documents bucket', () => {
  it('is private, limited to 10 MB and to PDF, JPEG, PNG and WebP', async () => {
    const bucket = await withDb(async (db) => {
      const { rows } = await db.query(
        "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'documents'",
      )
      return rows[0]
    })
    expect(bucket).toEqual({
      public: false,
      file_size_limit: String(10 * 1024 * 1024),
      allowed_mime_types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    })
  })
})

describe('documents bucket policies', () => {
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

  it('lets a member upload to the path of a document that is uploading, and members read it', async () => {
    const doc = await createDocument(member, ws)
    const { error } = await member.client.storage.from('documents').upload(doc.storage_path, PDF, options)
    expect(error).toBeNull()
    expect(await objectExists(doc.storage_path)).toBe(true)

    for (const user of [member, owner]) {
      const download = await user.client.storage.from('documents').download(doc.storage_path)
      expect(download.error).toBeNull()
      expect(new Uint8Array(await download.data!.arrayBuffer())).toEqual(PDF)
    }
  })

  it('refuses a path with no document, a document no longer uploading, and another name in its folder', async () => {
    const missing = `${ws}/${randomUUID()}/original`
    const queued = await createDocument(owner, ws)
    await withDb((db) => db.query("update public.documents set status = 'queued' where id = $1", [queued.id]))
    const other = await createDocument(owner, ws)
    const wrongName = other.storage_path.replace(/original$/, 'second')

    for (const path of [missing, queued.storage_path, wrongName, 'loose.pdf', `${ws}/original`]) {
      const { error } = await owner.client.storage.from('documents').upload(path, PDF, options)
      expect(error).not.toBeNull()
      expect(await objectExists(path)).toBe(false)
    }
  })

  it('refuses a non-member and anon an upload into the workspace', async () => {
    const doc = await createDocument(owner, ws)
    for (const client of [stranger.client, anonClient()]) {
      const { error } = await client.storage.from('documents').upload(doc.storage_path, PDF, options)
      expect(error).not.toBeNull()
    }
    expect(await objectExists(doc.storage_path)).toBe(false)
  })

  it('refuses a non-member and anon a read of the workspace’s objects', async () => {
    const doc = await createDocument(owner, ws)
    await owner.client.storage.from('documents').upload(doc.storage_path, PDF, options)
    for (const client of [stranger.client, anonClient()]) {
      const download = await client.storage.from('documents').download(doc.storage_path)
      expect(download.data).toBeNull()
      const list = await client.storage.from('documents').list(ws)
      expect(list.data ?? []).toEqual([])
      const signed = await client.storage.from('documents').createSignedUrl(doc.storage_path, 60)
      expect(signed.data).toBeNull()
    }
  })

  it('lets nobody overwrite or delete an object from the client, a member included', async () => {
    const doc = await createDocument(owner, ws)
    await owner.client.storage.from('documents').upload(doc.storage_path, PDF, options)
    const other = new TextEncoder().encode('%PDF-1.7\n%changed\n')

    for (const user of [owner, member, stranger]) {
      const overwrite = await user.client.storage
        .from('documents')
        .upload(doc.storage_path, other, { contentType: 'application/pdf', upsert: true })
      expect(overwrite.error).not.toBeNull()
      const update = await user.client.storage.from('documents').update(doc.storage_path, other, options)
      expect(update.error).not.toBeNull()
      await user.client.storage.from('documents').remove([doc.storage_path])
    }
    await anonClient().storage.from('documents').remove([doc.storage_path])

    expect(await objectExists(doc.storage_path)).toBe(true)
    const download = await owner.client.storage.from('documents').download(doc.storage_path)
    expect(new Uint8Array(await download.data!.arrayBuffer())).toEqual(PDF)
  })
})
