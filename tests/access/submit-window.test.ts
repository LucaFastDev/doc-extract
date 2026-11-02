import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { asServiceRole, withDb } from './local-db'
import { adminClient, apiUrl, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// Issue #85: submit-document stops accepting an upload 50 minutes after it was created, ten minutes
// before purge-files can remove it, so the two never work on the same document. Both functions are
// the real ones, served by the local stack.

const MONTH = "date_trunc('month', now() at time zone 'utc')::date"

describe('submit-document and the age of an upload', () => {
  let user: TestUser
  let ws: string
  let pdf: Uint8Array

  beforeAll(async () => {
    user = await signUp()
    ws = await personalWorkspaceId(user)
    const doc = await PDFDocument.create()
    doc.addPage()
    pdf = await doc.save()
  })

  /** An upload as the browser leaves it: the row from create_document and the object in Storage. */
  async function upload(age: string) {
    const { id, storage_path } = await createDocument(user, ws)
    const stored = await adminClient().storage.from('documents').upload(storage_path, pdf, { contentType: 'application/pdf' })
    if (stored.error) throw stored.error
    await withDb((db) => db.query('update public.documents set created_at = now() - $2::interval where id = $1', [id, age]))
    return { id, path: storage_path }
  }

  async function submit(id: string) {
    const session = await user.client.auth.getSession()
    const response = await fetch(`${apiUrl()}/functions/v1/submit-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session?.access_token}` },
      body: JSON.stringify({ document_id: id }),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  async function usage() {
    return withDb(async (db) => {
      const w = await db.query(`select pages_used from public.page_usage where workspace_id = $1 and period_start = ${MONTH}`, [ws])
      const a = await db.query('select pages_used from public.account_page_usage where user_id = $1', [user.id])
      return { workspace: w.rows[0]?.pages_used ?? 0, account: a.rows[0]?.pages_used ?? 0 }
    })
  }

  async function documentRow(id: string) {
    return withDb(async (db) => {
      const { rows } = await db.query('select status, pages_reserved from public.documents where id = $1', [id])
      return rows[0] ?? null
    })
  }

  it('refuses an upload 51 minutes old with 409, leaves it uploading and counts no pages', async () => {
    const { id } = await upload('51 minutes')
    const before = await usage()

    const { status, body } = await submit(id)

    expect(status).toBe(409)
    expect(body).toEqual({ error: 'invoice.pdf did not finish uploading. Upload it again.' })
    expect(await documentRow(id)).toEqual({ status: 'uploading', pages_reserved: false })
    expect(await usage()).toEqual(before)
  })

  it('queues an upload 5 minutes old, as before', async () => {
    const { id } = await upload('5 minutes')
    const { status, body } = await submit(id)
    expect(status).toBe(202)
    expect(body).toEqual({ document: { id, status: 'queued', page_count: 1 } })
  })

  it('has purge-files remove the same upload once it is past an hour, holding pages, and give the pages back', async () => {
    const { id, path } = await upload('51 minutes')

    // A submit that failed after reserve_pages leaves the pages on the row; the purge gives them back.
    const before = await usage()
    await withDb(async (db) => {
      await db.query('update public.documents set page_count = 1 where id = $1', [id])
      await db.query('begin')
      await asServiceRole(db)
      await db.query('select public.reserve_pages($1)', [id])
      await db.query('commit')
    })
    expect(await usage()).toEqual({ workspace: before.workspace + 1, account: before.account + 1 })
    await withDb((db) => db.query("update public.documents set created_at = now() - interval '61 minutes' where id = $1", [id]))

    const cronSecret = await withDb(async (db) => (await db.query("select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'")).rows[0].decrypted_secret)
    const response = await fetch(`${apiUrl()}/functions/v1/purge-files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
      body: '{}',
    })
    expect(response.status).toBe(200)

    expect(await documentRow(id)).toBeNull()
    expect(await withDb(async (db) => (await db.query('select 1 from storage.objects where bucket_id = $1 and name = $2', ['documents', path])).rowCount)).toBe(0)
    expect(await usage()).toEqual(before)
  })
})
