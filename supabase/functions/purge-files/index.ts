import { createClient } from '@supabase/supabase-js'
import { requireEnv } from '../_shared/env.ts'
import { handleRequest } from './handler.ts'
import { purgeFiles, type ExpiredDocument, type PurgeDeps, type StaleUpload } from './purge.ts'

// purge-files (ARCHITECTURE.md sections 6.1 and 8): pg_cron posts here daily at 03:00 UTC. Each
// request removes the files of documents 7 days old, the uploads left for an hour, and the stale
// spend reservations, and answers with the counts. Everything runs with the service role, on the
// documents table and the documents bucket only (Lead ruling 5 on #48).

const SUPABASE_URL = requireEnv('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
const CRON_SECRET = requireEnv('CRON_SECRET')

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const deps: PurgeDeps = {
  now: () => new Date(),
  async selectExpired(before, afterId, limit) {
    let query = admin
      .from('documents')
      .select('id, storage_path')
      .lt('created_at', before.toISOString())
      .is('file_deleted_at', null)
      .order('id')
      .limit(limit)
    if (afterId) query = query.gt('id', afterId)
    const { data, error } = await query.returns<ExpiredDocument[]>()
    if (error) throw error
    return data
  },
  async removeObjects(paths) {
    // An object already gone is not an error: it is simply not in the list of removed objects.
    const { error } = await admin.storage.from('documents').remove(paths)
    if (error) console.error('purge-files could not remove', paths.length, 'objects', error)
    return !error
  },
  async markFileDeleted(ids, at) {
    const { error } = await admin.from('documents').update({ file_deleted_at: at.toISOString() }).in('id', ids).is('file_deleted_at', null)
    if (error) throw error
  },
  async selectStaleUploads(before, afterId, limit) {
    let query = admin
      .from('documents')
      .select('id, storage_path, pages_reserved, file_deleted_at')
      .eq('status', 'uploading')
      .lt('created_at', before.toISOString())
      .order('id')
      .limit(limit)
    if (afterId) query = query.gt('id', afterId)
    const { data, error } = await query.returns<StaleUpload[]>()
    if (error) throw error
    return data
  },
  async releasePages(id) {
    const { error } = await admin.rpc('release_pages', { document_id: id })
    if (error) throw error
  },
  async deleteUpload(id) {
    // Only while it is still uploading: a document submitted meanwhile is left alone.
    const { data, error } = await admin.from('documents').delete().eq('id', id).eq('status', 'uploading').select('id')
    if (error) throw error
    return data.length > 0
  },
  async releaseStaleSpend() {
    const { data, error } = await admin.rpc('release_stale_spend_reservations')
    if (error) throw error
    return data as number
  },
}

Deno.serve((req) => handleRequest(req, CRON_SECRET, () => purgeFiles(deps)))
