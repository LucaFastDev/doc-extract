import { createClient } from '@supabase/supabase-js'
import { requireEnv } from '../_shared/env.ts'
import { submitDocument, type SubmitDeps, type SubmittedDocument } from './submit.ts'

// submit-document (ARCHITECTURE.md section 6.1): the browser posts {document_id} once the file is
// in Storage. Reads run as the caller, through RLS; the file and every write use the service role.

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

function deps(authorization: string): SubmitDeps {
  const jwt = authorization.replace(/^Bearer\s+/i, '')
  const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: noSession,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: noSession })

  const update = async (id: string, values: Record<string, unknown>) => {
    // Only a document still uploading changes here, so a second submit cannot undo the first.
    const { error } = await admin.from('documents').update(values).eq('id', id).eq('status', 'uploading')
    if (error) throw error
  }

  return {
    async userId() {
      if (!jwt) return null
      const { data, error } = await asCaller.auth.getUser(jwt)
      return error ? null : (data.user?.id ?? null)
    },
    async loadDocument(id) {
      const { data, error } = await asCaller
        .from('documents')
        .select('id, workspace_id, status, file_name, mime_type, storage_path')
        .eq('id', id)
        .maybeSingle<SubmittedDocument>()
      if (error) throw error
      return data
    },
    async isMember(workspaceId) {
      const { data, error } = await asCaller.rpc('is_member', { ws: workspaceId })
      if (error) throw error
      return data === true
    },
    async download(path) {
      const { data, error } = await admin.storage.from('documents').download(path)
      if (error || !data) return null
      return new Uint8Array(await data.arrayBuffer())
    },
    recordFile: (id, file) => update(id, file),
    async reservePages(id) {
      const { data, error } = await admin.rpc('reserve_pages', { document_id: id })
      if (error) throw error
      return data === true
    },
    async allowance(workspaceId) {
      const { data, error } = await asCaller.rpc('get_page_allowance', { ws: workspaceId }).single()
      if (error) throw error
      return data as Awaited<ReturnType<SubmitDeps['allowance']>>
    },
    reject: (id, reason, file) => update(id, { status: 'rejected', status_reason: reason, ...file }),
    queue: (id) => update(id, { status: 'queued', status_reason: null }),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405, headers: CORS })

  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    // submitDocument answers 400 for a missing document id.
  }
  try {
    const result = await submitDocument(body, deps(req.headers.get('Authorization') ?? ''))
    return Response.json(result.body, { status: result.status, headers: CORS })
  } catch (error) {
    console.error('submit-document failed', error)
    return Response.json({ error: 'The upload could not be submitted. Try again.' }, { status: 500, headers: CORS })
  }
})
