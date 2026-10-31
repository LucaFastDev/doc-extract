import type { SupabaseClient } from '@supabase/supabase-js'

// Deleting one document (ARCHITECTURE.md section 6.2, PRD US-19.1, OQ-20), behind
// DELETE /api/documents/[id]. The caller's client reads the document, so RLS finds it only for a
// member of its workspace; the service-role client removes the file through the Storage API, then
// calls delete_document. tests/access/review.test.ts runs this with real clients.

export interface DeleteClients {
  /** The server client, as the signed-in caller. */
  asCaller: SupabaseClient
  /** The service-role client. */
  admin: () => SupabaseClient
}

export interface DeleteResult {
  status: 204 | 401 | 404 | 500
  error?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NOT_FOUND: DeleteResult = { status: 404, error: 'This document does not exist.' }

/**
 * Any member may delete any document of the workspace, in any status. Nothing changes for anyone
 * else. If removing the file fails, the row stays, so the delete can be run again.
 */
export async function deleteDocument(id: string, { asCaller, admin }: DeleteClients): Promise<DeleteResult> {
  if (!UUID.test(id)) return NOT_FOUND
  const {
    data: { user },
  } = await asCaller.auth.getUser()
  if (!user) return { status: 401, error: 'Sign in to delete documents.' }

  const { data: doc, error } = await asCaller
    .from('documents')
    .select('id, workspace_id, storage_path, file_deleted_at')
    .eq('id', id)
    .maybeSingle<{ id: string; workspace_id: string; storage_path: string | null; file_deleted_at: string | null }>()
  if (error) throw error
  if (!doc) return NOT_FOUND
  const member = await asCaller.rpc('is_member', { ws: doc.workspace_id })
  if (member.error) throw member.error
  if (member.data !== true) return NOT_FOUND

  const service = admin()
  if (!doc.file_deleted_at && doc.storage_path) {
    // An object that is already gone counts as removed: remove() reports no error for it.
    const removed = await service.storage.from('documents').remove([doc.storage_path])
    if (removed.error) {
      console.error('The file of document', doc.id, 'could not be removed.', removed.error)
      return { status: 500, error: 'The document could not be deleted. Try again.' }
    }
  }
  const deleted = await service.rpc('delete_document', { document_id: doc.id })
  if (deleted.error) {
    console.error('Document', doc.id, 'could not be deleted.', deleted.error)
    return { status: 500, error: 'The document could not be deleted. Try again.' }
  }
  return { status: 204 }
}
