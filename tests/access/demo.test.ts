import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { adminClient, anonClient, signUp } from './users'

// The demo's samples (ARCHITECTURE.md sections 4.2, 4.4 and 5; issue #41 criteria 4, 9 and 10):
// anon and members of any workspace read the published demo_documents rows and their files in the
// demo bucket, and nothing unpublished; no client inserts, updates or deletes a row or an object.

const SAMPLES = new URL('../../demo/samples/', import.meta.url)
const PUBLISHED_FILE = 'invoice-total-mismatch.pdf'
const PDF = { contentType: 'application/pdf' }

interface Reader {
  name: string
  client: SupabaseClient
}

let readers: Reader[]
const hidden = `access-unpublished-${randomUUID()}`
const hiddenFile = `${hidden}.pdf`

beforeAll(async () => {
  const [a, b] = await Promise.all([signUp('Member of A'), signUp('Member of B')])
  readers = [
    { name: 'anon', client: anonClient() },
    { name: 'a member of workspace A', client: a.client },
    { name: 'a member of workspace B', client: b.client },
  ]
  // A published sample's file, as the e2e setup uploads it, and an unpublished sample with its own.
  const admin = adminClient()
  const bytes = readFileSync(new URL(PUBLISHED_FILE, SAMPLES))
  const published = await admin.storage.from('demo').upload(PUBLISHED_FILE, bytes, { ...PDF, upsert: true })
  if (published.error) throw published.error
  const unpublished = await admin.storage.from('demo').upload(hiddenFile, bytes, { ...PDF, upsert: true })
  if (unpublished.error) throw unpublished.error
  await withDb((db) =>
    db.query(
      `insert into public.demo_documents (slug, doc_type, title, summary, file_path, page_count, result, sort_order, published)
       values ($1, 'invoice', 'Unpublished', 'Not shown', $2, 1, '{}'::jsonb, 99, false)`,
      [hidden, hiddenFile],
    ),
  )
})

afterAll(async () => {
  await withDb((db) => db.query('delete from public.demo_documents where slug = $1', [hidden]))
  await adminClient().storage.from('demo').remove([hiddenFile])
})

async function publishedSlugs(): Promise<string[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ slug: string }>('select slug from public.demo_documents where published order by sort_order')
    return rows.map((r) => r.slug)
  })
}

async function objectExists(name: string): Promise<boolean> {
  return withDb(async (db) => {
    const { rowCount } = await db.query("select 1 from storage.objects where bucket_id = 'demo' and name = $1", [name])
    return rowCount === 1
  })
}

describe('demo_documents', () => {
  it('has the seven samples, published, from its migration', async () => {
    expect(await publishedSlugs()).toEqual([
      'invoice-total-mismatch',
      'invoice-duplicate',
      'receipt-photo',
      'bank-statement',
      'purchase-order',
      'delivery-note',
      'quote-date-error',
    ])
  })

  it('has RLS on, and anon and authenticated may only select', async () => {
    const privileges = await withDb(async (db) => {
      const { rows } = await db.query<{ role: string; rls: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
        `select r.role, c.relrowsecurity as rls,
                has_table_privilege(r.role, 'public.demo_documents', 'select') as sel,
                has_table_privilege(r.role, 'public.demo_documents', 'insert') as ins,
                has_table_privilege(r.role, 'public.demo_documents', 'update') as upd,
                has_table_privilege(r.role, 'public.demo_documents', 'delete') as del
         from (values ('anon'), ('authenticated')) as r(role), pg_class c
         where c.oid = 'public.demo_documents'::regclass`,
      )
      return rows
    })
    expect(privileges).toEqual([
      { role: 'anon', rls: true, sel: true, ins: false, upd: false, del: false },
      { role: 'authenticated', rls: true, sel: true, ins: false, upd: false, del: false },
    ])
  })

  it('shows anon and members of A and B the published rows only, results included', async () => {
    const published = await publishedSlugs()
    for (const { name, client } of readers) {
      const { data, error } = await client.from('demo_documents').select('slug, file_path, result').order('sort_order')
      expect(error, name).toBeNull()
      expect(data!.map((r) => r.slug), name).toEqual(published)
      expect(data!.every((r) => Array.isArray(r.result.fields) && Array.isArray(r.result.checks)), name).toBe(true)
      const one = await client.from('demo_documents').select('slug').eq('slug', hidden)
      expect(one.data, name).toEqual([])
    }
  })

  it('refuses every client an insert, an update and a delete', async () => {
    for (const { name, client } of readers) {
      const insert = await client.from('demo_documents').insert({
        slug: `client-${randomUUID()}`,
        doc_type: 'invoice',
        title: 'Inserted',
        summary: 'By a client',
        file_path: `client-${randomUUID()}.pdf`,
        page_count: 1,
        result: {},
        sort_order: 100,
        published: true,
      })
      expect(insert.error, name).not.toBeNull()
      await client.from('demo_documents').update({ title: 'Changed', published: true }).in('slug', [PUBLISHED_FILE.replace('.pdf', ''), hidden])
      await client.from('demo_documents').delete().in('slug', [PUBLISHED_FILE.replace('.pdf', ''), hidden])
    }
    const rows = await withDb(async (db) => {
      const { rows } = await db.query<{ slug: string; title: string; published: boolean }>(
        'select slug, title, published from public.demo_documents where slug = any($1) order by slug',
        [[PUBLISHED_FILE.replace('.pdf', ''), hidden]],
      )
      return rows
    })
    expect(rows).toEqual([
      { slug: hidden, title: 'Unpublished', published: false },
      { slug: 'invoice-total-mismatch', title: 'Invoice with a wrong total', published: true },
    ])
    expect(await publishedSlugs()).toHaveLength(7)
  })
})

describe('demo bucket', () => {
  it('is private, limited to 10 MB and to PDF, JPEG, PNG and WebP', async () => {
    const bucket = await withDb(async (db) => {
      const { rows } = await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'demo'")
      return rows[0]
    })
    expect(bucket).toEqual({
      public: false,
      file_size_limit: String(10 * 1024 * 1024),
      allowed_mime_types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    })
  })

  it('lets anon and members of A and B read a published sample’s file and sign a URL to it', async () => {
    const bytes = new Uint8Array(readFileSync(new URL(PUBLISHED_FILE, SAMPLES)))
    for (const { name, client } of readers) {
      const download = await client.storage.from('demo').download(PUBLISHED_FILE)
      expect(download.error, name).toBeNull()
      expect(new Uint8Array(await download.data!.arrayBuffer()), name).toEqual(bytes)
      const signed = await client.storage.from('demo').createSignedUrl(PUBLISHED_FILE, 600)
      expect(signed.error, name).toBeNull()
      const fetched = await fetch(signed.data!.signedUrl)
      expect(fetched.status, name).toBe(200)
    }
  })

  it('hides an unpublished sample’s file from anon and members of A and B', async () => {
    for (const { name, client } of readers) {
      const download = await client.storage.from('demo').download(hiddenFile)
      expect(download.data, name).toBeNull()
      const signed = await client.storage.from('demo').createSignedUrl(hiddenFile, 600)
      expect(signed.data, name).toBeNull()
      const list = await client.storage.from('demo').list('', { limit: 1000 })
      expect((list.data ?? []).map((o) => o.name), name).not.toContain(hiddenFile)
    }
  })

  it('refuses every client an upload, an overwrite and a delete', async () => {
    const other = new TextEncoder().encode('%PDF-1.7\n%changed\n')
    const bytes = new Uint8Array(readFileSync(new URL(PUBLISHED_FILE, SAMPLES)))
    for (const { name, client } of readers) {
      const added = `client-${randomUUID()}.pdf`
      const upload = await client.storage.from('demo').upload(added, other, PDF)
      expect(upload.error, name).not.toBeNull()
      expect(await objectExists(added), name).toBe(false)
      const overwrite = await client.storage.from('demo').upload(PUBLISHED_FILE, other, { ...PDF, upsert: true })
      expect(overwrite.error, name).not.toBeNull()
      const update = await client.storage.from('demo').update(PUBLISHED_FILE, other, PDF)
      expect(update.error, name).not.toBeNull()
      await client.storage.from('demo').remove([PUBLISHED_FILE, hiddenFile])
    }
    expect(await objectExists(PUBLISHED_FILE)).toBe(true)
    expect(await objectExists(hiddenFile)).toBe(true)
    const download = await anonClient().storage.from('demo').download(PUBLISHED_FILE)
    expect(new Uint8Array(await download.data!.arrayBuffer())).toEqual(bytes)
  })
})

describe('demo functions', () => {
  it('adds no database function: the policies read demo_documents through its own select policy', async () => {
    const functions = await withDb(async (db) => {
      const { rows } = await db.query<{ name: string }>(
        `select p.proname as name from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname like '%demo%'`,
      )
      return rows.map((r) => r.name)
    })
    expect(functions).toEqual([])
  })
})
