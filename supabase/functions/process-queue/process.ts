import { prepareResult, type DocType } from '../../../shared/doctypes/index.ts'
import type { CheckResult, FieldRow } from '../../../shared/doctypes/fields.ts'
import { ClaudeError, PROMPT_VERSION, type ClaudeClient, type ExtractResult, type Usage } from '../_shared/claude.ts'

// process-queue's steps (ARCHITECTURE.md sections 6.3 and 6.4), with the queue, the database,
// Storage and Claude behind ProcessDeps so the unit tests run them without any of them. index.ts
// supplies the real ones. One message, one document, one Claude call per run.

export interface QueueMessage {
  msg_id: number | string
  read_ct: number
  message: { document_id?: unknown } | null
}

export interface QueuedDocument {
  id: string
  status: string
  attempts: number
  page_count: number
  mime_type: string
  storage_path: string
  doc_type: string | null
  doc_type_source: string | null
  processing_started_at: string | null
  file_deleted_at: string | null
}

/** The app_config columns process-queue reads. */
export interface AppConfig {
  model: string
  input_usd_per_mtok: number
  output_usd_per_mtok: number
  base_input_tokens: number
  max_input_tokens_per_page: number
  max_output_tokens: number
  confidence_threshold: number
  amount_tolerance: number | string
}

/** What record_extraction stores for one attempt. */
export interface ExtractionRecord {
  outcome: 'ok' | 'unsupported' | 'retryable_error' | 'fatal_error' | 'invalid_output'
  status: 'needs_review' | 'unsupported' | 'queued' | 'failed'
  status_reason?: string | null
  model: string
  prompt_version: string
  tool_name?: string | null
  error?: string | null
  raw_output?: unknown
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number
  doc_type?: string
  fields?: FieldRow[]
  checks?: CheckResult[]
}

export interface ProcessDeps {
  /** CLAUDE_MODEL: overrides app_config.model where set, locally and in the eval (Lead ruling 4). */
  modelOverride: string | null
  now(): Date
  /** extract_read with a 300 s visibility timeout, one message. */
  read(): Promise<QueueMessage | null>
  archive(msgId: QueueMessage['msg_id']): Promise<void>
  /** extract_set_vt: the message reappears after this many seconds. */
  delay(msgId: QueueMessage['msg_id'], seconds: number): Promise<void>
  loadDocument(id: string): Promise<QueuedDocument | null>
  config(): Promise<AppConfig>
  /** The document's invalid outputs since it was last retried by hand. */
  priorInvalidOutputs(id: string): Promise<number>
  reserveSpend(id: string, estimate: number): Promise<{ reservation: string | null; refused_by: 'daily' | 'monthly' | null }>
  /** Sets status waiting_budget with the reason. */
  setWaiting(id: string, reason: string): Promise<void>
  /** Sets status processing, processing_started_at and the attempt count; clears the reason. */
  startProcessing(id: string, attempts: number): Promise<void>
  /** The file from Storage, or null when it cannot be read. */
  download(path: string): Promise<Uint8Array | null>
  claude(model: string, maxTokens: number): ClaudeClient
  /** record_extraction: 'recorded', 'deleted' or 'stale'. */
  record(id: string, reservation: string | null, result: ExtractionRecord): Promise<string>
}

export type ProcessOutcome =
  | { outcome: 'empty' | 'skipped' }
  | { outcome: 'waiting' | 'needs_review' | 'unsupported' | 'retry' | 'failed'; document_id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Seconds a refused message waits before it is read again (section 6.3 step 2). */
export const WAIT_SECONDS = 600
/** A run that started processing longer ago than this was killed (section 6.4). */
const STALE_MS = 10 * 60 * 1000
/** The attempt that is the last (section 6.4). */
const MAX_ATTEMPTS = 3

/** The upper bound of a call's cost (section 7). */
export function estimateCost(config: AppConfig, pages: number): number {
  const input = (Number(config.base_input_tokens) + pages * Number(config.max_input_tokens_per_page)) * Number(config.input_usd_per_mtok)
  const output = Number(config.max_output_tokens) * Number(config.output_usd_per_mtok)
  return (input + output) / 1e6
}

function cost(config: AppConfig, usage: Usage | undefined): number {
  if (!usage) return 0
  const usd = (usage.input_tokens * Number(config.input_usd_per_mtok) + usage.output_tokens * Number(config.output_usd_per_mtok)) / 1e6
  return Math.round(usd * 1e6) / 1e6
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The status_reason of a waiting document: which limit, and when it resets (PRD US-12.1 AC-2). */
export function waitingReason(refusedBy: 'daily' | 'monthly', now: Date): string {
  const reset =
    refusedBy === 'daily'
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const date = `${reset.getUTCDate()} ${MONTHS[reset.getUTCMonth()]} ${reset.getUTCFullYear()}`
  return `The ${refusedBy} AI spending limit is reached. It resets at 00:00 UTC on ${date}, when processing resumes.`
}

/**
 * Whether this run takes the document: 'go'; 'archive' when it is done, deleted or retried by
 * hand; or, while another run is processing it, the seconds until that run would count as killed.
 * The message comes back then rather than being archived: it reappears after its 300 s visibility
 * timeout, before a killed run is 10 minutes stale, and archiving it would leave the document in
 * processing for good (section 6.4).
 */
function decide(doc: QueuedDocument | null, now: Date): 'go' | 'archive' | number {
  if (!doc) return 'archive'
  if (doc.status === 'queued' || doc.status === 'waiting_budget') return 'go'
  if (doc.status !== 'processing') return 'archive'
  const started = doc.processing_started_at ? Date.parse(doc.processing_started_at) : 0
  const elapsed = now.getTime() - started
  return elapsed > STALE_MS ? 'go' : Math.ceil((STALE_MS - elapsed) / 1000) + 1
}

export async function processQueue(deps: ProcessDeps): Promise<ProcessOutcome> {
  const msg = await deps.read()
  if (!msg) return { outcome: 'empty' }

  // Step 1: only a document still waiting for this message is processed.
  const id = msg.message?.document_id
  const doc = typeof id === 'string' && UUID.test(id) ? await deps.loadDocument(id) : null
  const decision = decide(doc, deps.now())
  if (decision === 'archive') await deps.archive(msg.msg_id)
  else if (decision !== 'go') await deps.delay(msg.msg_id, decision)
  if (!doc || decision !== 'go') return { outcome: 'skipped' }

  // Step 2: the spend cap and the daily ceiling. Not a failure, and no attempt (OQ-23).
  const config = await deps.config()
  const { reservation, refused_by } = await deps.reserveSpend(doc.id, estimateCost(config, doc.page_count))
  if (refused_by) {
    await deps.setWaiting(doc.id, waitingReason(refused_by, deps.now()))
    await deps.delay(msg.msg_id, WAIT_SECONDS)
    return { outcome: 'waiting', document_id: doc.id }
  }

  // Step 3.
  const attempts = doc.attempts + 1
  await deps.startProcessing(doc.id, attempts)
  const model = deps.modelOverride || config.model
  const base = { model, prompt_version: PROMPT_VERSION }

  const finish = async (record: ExtractionRecord, final: boolean): Promise<ProcessOutcome> => {
    const stored = await deps.record(doc.id, reservation, record)
    // A retryable attempt leaves the message to reappear after its visibility timeout, unless the
    // document is gone or was moved on meanwhile.
    if (final || stored !== 'recorded') await deps.archive(msg.msg_id)
    const outcome = record.status === 'queued' ? 'retry' : record.status
    return { outcome, document_id: doc.id }
  }

  /** A failure that is not fatal by itself: retried until the third attempt (section 6.4). */
  const retryOrFail = (record: Omit<ExtractionRecord, 'status' | 'status_reason'>, reason: string) => {
    if (attempts >= MAX_ATTEMPTS) {
      return finish(
        { ...record, status: 'failed', status_reason: `Extraction failed ${attempts} times. The last time, ${reason} Retry later.` },
        true,
      )
    }
    return finish({ ...record, status: 'queued', status_reason: null }, false)
  }

  const invalidOutput = async (usage: Usage | undefined, reason: string, raw: unknown, toolName: string | null) => {
    const record = {
      ...base,
      outcome: 'invalid_output' as const,
      tool_name: toolName,
      error: reason,
      raw_output: raw ?? null,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cost_usd: cost(config, usage),
    }
    if ((await deps.priorInvalidOutputs(doc.id)) >= 1) {
      return finish(
        { ...record, status: 'failed', status_reason: 'Claude’s answer did not have the expected form, twice. Retry later.' },
        true,
      )
    }
    return retryOrFail(record, reason)
  }

  // Step 4: the file, then Claude.
  const bytes = await deps.download(doc.storage_path)
  if (!bytes) {
    const record = { ...base, outcome: 'retryable_error' as const, input_tokens: null, output_tokens: null, cost_usd: 0 }
    if (doc.file_deleted_at) {
      const reason = 'The file was deleted before it could be read.'
      return finish({ ...record, outcome: 'fatal_error', error: reason, status: 'failed', status_reason: reason }, true)
    }
    return retryOrFail({ ...record, error: 'The file could not be read from Storage.' }, 'the file could not be read from Storage.')
  }

  const chosen = doc.doc_type_source === 'user' ? (doc.doc_type as DocType) : null
  let result: ExtractResult
  try {
    result = await deps.claude(model, Number(config.max_output_tokens)).extract({ bytes, mimeType: doc.mime_type }, chosen)
  } catch (error) {
    if (!(error instanceof ClaudeError)) throw error
    if (error.kind === 'invalid_output') return invalidOutput(error.usage, error.reason, error.details.raw, null)
    const record = {
      ...base,
      error: error.message,
      raw_output: error.details.raw ?? null,
      input_tokens: error.usage?.input_tokens ?? null,
      output_tokens: error.usage?.output_tokens ?? null,
      cost_usd: cost(config, error.usage),
    }
    if (error.kind === 'fatal') {
      return finish({ ...record, outcome: 'fatal_error', status: 'failed', status_reason: error.reason }, true)
    }
    return retryOrFail({ ...record, outcome: 'retryable_error' }, error.reason)
  }

  const paid = {
    ...base,
    tool_name: result.toolName,
    raw_output: result.input,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cost_usd: cost(config, result.usage),
  }

  // Step 5: none of the types (OQ-1).
  if (result.docType === 'not_supported') {
    const reason = (result.input as { reason?: unknown } | null)?.reason
    if (typeof reason !== 'string') return invalidOutput(result.usage, 'record_not_supported had no reason.', result.input, result.toolName)
    return finish(
      { ...paid, outcome: 'unsupported', status: 'unsupported', status_reason: `Not a supported document type: ${reason.trim()}` },
      true,
    )
  }

  // Steps 6 to 8: validate again, normalise, check, flag, store.
  const prepared = prepareResult(result.docType, result.input, {
    confidenceThreshold: Number(config.confidence_threshold),
    amountTolerance: String(config.amount_tolerance),
  })
  if (!prepared.ok) {
    return invalidOutput(result.usage, `The ${result.toolName} input did not match its schema: ${prepared.errors.join('; ')}`, result.input, result.toolName)
  }
  return finish(
    {
      ...paid,
      outcome: 'ok',
      status: 'needs_review',
      status_reason: null,
      doc_type: result.docType,
      fields: prepared.fields,
      checks: prepared.checks,
    },
    true,
  )
}
