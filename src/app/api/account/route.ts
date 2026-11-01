import { deleteAccount } from '@/lib/account/delete'
import { getStripe } from '@/lib/stripe'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

// DELETE /api/account (ARCHITECTURE.md section 6.2, PRD US-18.2): the browser calls it once the user
// has confirmed. On 204 the session cookies are cleared through the server client's cookie store.
export async function DELETE() {
  const result = await deleteAccount({ asCaller: await createClient(), admin: createServiceRoleClient, stripe: getStripe })
  if (result.status === 204) return new Response(null, { status: 204 })
  return Response.json({ error: result.error, workspaces: result.workspaces }, { status: result.status })
}
