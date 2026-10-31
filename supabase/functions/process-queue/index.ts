import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { createClaudeClient } from '../_shared/claude.ts'
import { optionalEnv, requireEnv } from '../_shared/env.ts'
import { handleRequest } from './handler.ts'
import { processQueue, type AppConfig, type ProcessDeps, type QueuedDocument, type QueueMessage } from './process.ts'

// process-queue (ARCHITECTURE.md sections 6.1, 6.3 and 6.4): pg_cron posts here every 10 seconds;
// each request takes one message from the extract queue and extracts its document. Everything
// runs with the service role. ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY are required with no
// default, so a function missing either fails at startup instead of reaching the real API.

const SUPABASE_URL = requireEnv('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
const CRON_SECRET = requireEnv('CRON_SECRET')
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY')
const ANTHROPIC_BASE_URL = requireEnv('ANTHROPIC_BASE_URL')
const CLAUDE_MODEL = optionalEnv('CLAUDE_MODEL')

/** The message is read again after this many seconds if the run does not finish (section 6.3). */
const VISIBILITY_SECONDS = 300

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

// Retries are the queue's, not the SDK's (section 6.4); the timeout keeps a run inside the Edge
// Function's time limit.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, baseURL: ANTHROPIC_BASE_URL, maxRetries: 0, timeout: 120_000 })

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args)
  if (error) throw error
  return data as T
}

async function setStatus(id: string, values: Record<string, unknown>) {
  // Only a document this step may move; one deleted or retried meanwhile is left alone.
  const { error } = await admin
    .from('documents')
    .update(values)
    .eq('id', id)
    .in('status', ['queued', 'waiting_budget', 'processing'])
  if (error) throw error
}

const deps: ProcessDeps = {
  modelOverride: CLAUDE_MODEL,
  now: () => new Date(),
  async read() {
    const rows = await rpc<QueueMessage[]>('extract_read', { vt: VISIBILITY_SECONDS, qty: 1 })
    return rows[0] ?? null
  },
  async archive(msgId) {
    await rpc('extract_archive', { msg_id: msgId })
  },
  async delay(msgId, seconds) {
    await rpc('extract_set_vt', { msg_id: msgId, vt: seconds })
  },
  async loadDocument(id) {
    const { data, error } = await admin
      .from('documents')
      .select('id, status, attempts, page_count, mime_type, storage_path, doc_type, doc_type_source, processing_started_at, file_deleted_at')
      .eq('id', id)
      .maybeSingle<QueuedDocument>()
    if (error) throw error
    return data
  },
  async config() {
    const { data, error } = await admin.from('app_config').select('*').eq('id', true).single<AppConfig>()
    if (error) throw error
    return data
  },
  async priorInvalidOutputs(id) {
    // Counted since the document was last retried by hand, which starts its attempts again.
    const retried = await admin
      .from('document_events')
      .select('created_at')
      .eq('document_id', id)
      .eq('kind', 'retried')
      .order('created_at', { ascending: false })
      .limit(1)
    if (retried.error) throw retried.error
    let query = admin
      .from('extractions')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', id)
      .eq('outcome', 'invalid_output')
    if (retried.data[0]) query = query.gt('created_at', retried.data[0].created_at)
    const { count, error } = await query
    if (error) throw error
    return count ?? 0
  },
  async reserveSpend(id, estimate) {
    const rows = await rpc<{ reservation: string | null; refused_by: 'daily' | 'monthly' | null }[]>('reserve_spend', {
      document_id: id,
      estimate: Math.ceil(estimate * 1e6) / 1e6,
    })
    return rows[0]
  },
  setWaiting: (id, reason) => setStatus(id, { status: 'waiting_budget', status_reason: reason }),
  startProcessing: (id, attempts) =>
    setStatus(id, { status: 'processing', status_reason: null, processing_started_at: new Date().toISOString(), attempts }),
  async download(path) {
    const { data, error } = await admin.storage.from('documents').download(path)
    if (error || !data) {
      console.error('process-queue could not download', path, error)
      return null
    }
    return new Uint8Array(await data.arrayBuffer())
  },
  claude: (model, maxTokens) =>
    createClaudeClient({ create: (params) => anthropic.messages.create(params as never) }, { model, maxTokens }),
  record: (id, reservation, result) =>
    rpc<string>('record_extraction', { document_id: id, reservation, result }),
}

Deno.serve((req) => handleRequest(req, CRON_SECRET, () => processQueue(deps)))
