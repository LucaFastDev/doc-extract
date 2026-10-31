import { deleteDocument } from '@/lib/documents/delete'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

// DELETE /api/documents/[id] (ARCHITECTURE.md section 6.2, PRD US-19.1): the browser calls it once
// the user has confirmed. A non-member, or a document that does not exist, gets 404 and nothing
// changes.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = await deleteDocument(id, { asCaller: await createClient(), admin: createServiceRoleClient })
  if (result.status === 204) return new Response(null, { status: 204 })
  return Response.json({ error: result.error }, { status: result.status })
}
