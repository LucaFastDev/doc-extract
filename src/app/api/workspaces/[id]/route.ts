import { getStripe } from '@/lib/stripe'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { deleteWorkspace } from '@/lib/workspace/delete'

// DELETE /api/workspaces/[id] (ARCHITECTURE.md section 6.2, PRD US-18.1): the browser calls it once
// the owner has typed the workspace's name. The typed name is the browser's gate only (Lead ruling
// 1 on #61); this handler checks is_owner itself.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = await deleteWorkspace(id, { asCaller: await createClient(), admin: createServiceRoleClient, stripe: getStripe })
  if (result.status === 204) return new Response(null, { status: 204 })
  return Response.json({ error: result.error }, { status: result.status })
}
