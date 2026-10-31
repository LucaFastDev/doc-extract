import { createClient } from '@supabase/supabase-js'
import { requireEnv } from '../_shared/env.ts'
import type { StoredField } from '../../../shared/doctypes/review.ts'
import { approveDocument, type ApprovalOutcome, type ApproveDeps, type ApprovedDocument } from './approve.ts'

// approve-document (ARCHITECTURE.md section 6.1): the review screen posts {document_id}. Reads run
// as the caller, through RLS; app_config and approve_document use the service role.

const SUPABASE_URL = requireEnv('SUPABASE_URL')
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

// The browser calls from the app's own origin. The caller's JWT, not the origin, is what is trusted.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const noSession = { persistSession: false, autoRefreshToken: false }

function deps(authorization: string): ApproveDeps {
  const jwt = authorization.replace(/^Bearer\s+/i, '')
  const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: noSession,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: noSession })

  return {
    async userId() {
      if (!jwt) return null
      const { data, error } = await asCaller.auth.getUser(jwt)
      return error ? null : (data.user?.id ?? null)
    },
    async loadDocument(id) {
      const { data, error } = await asCaller
        .from('documents')
        .select('id, workspace_id, status, doc_type, file_name')
        .eq('id', id)
        .maybeSingle<ApprovedDocument>()
      if (error) throw error
      return data
    },
    async isMember(workspaceId) {
      const { data, error } = await asCaller.rpc('is_member', { ws: workspaceId })
      if (error) throw error
      return data === true
    },
    async loadFields(id) {
      const { data, error } = await asCaller
        .from('extraction_fields')
        .select('path, kind, extracted_value, corrected_value, confidence, flags')
        .eq('document_id', id)
        .returns<StoredField[]>()
      if (error) throw error
      return data.map((r) => ({ ...r, confidence: r.confidence === null ? null : Number(r.confidence) }))
    },
    async amountTolerance() {
      const { data, error } = await admin.from('app_config').select('amount_tolerance').single<{ amount_tolerance: number | string }>()
      if (error) throw error
      return String(data.amount_tolerance)
    },
    now: () => new Date(),
    async approve(id, actor, input) {
      const { data, error } = await admin.rpc('approve_document', { document_id: id, actor, result: input })
      if (error) throw error
      return data as ApprovalOutcome
    },
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405, headers: CORS })

  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    // approveDocument answers 400 for a missing document id.
  }
  try {
    const result = await approveDocument(body, deps(req.headers.get('Authorization') ?? ''))
    return Response.json(result.body, { status: result.status, headers: CORS })
  } catch (error) {
    console.error('approve-document failed', error)
    return Response.json({ error: 'The document could not be approved. Try again.' }, { status: 500, headers: CORS })
  }
})
