import { docTypeOfTool, toolsFor, type DocType } from '../../../shared/doctypes/index.ts'
import type { ToolDefinition } from '../../../shared/doctypes/fields.ts'

// The Claude client (ARCHITECTURE.md section 9). process-queue gives it the Messages API of the
// official SDK; the unit tests give it recorded responses. One call per document: the file as a
// base64 document or image block, and the tools under tool_choice auto with strict schemas, since
// Sonnet 5.5 refuses forced tool use (Lead ruling 1 on #24). Exactly one tool call is a result;
// anything else is invalid output.

/** Stored on every extractions row, so a result can be traced to the prompt that made it. */
export const PROMPT_VERSION = '2026-10-31.2'

export const SYSTEM_PROMPT = `You read one business document and record what it says by calling exactly one of the tools you are given, once. Write no other text.

- If the document is of the type a record_ tool records, call that tool. If record_not_supported is offered and the document is none of those types, call it with a short reason.
- Read only what is printed. Never invent a value: give an empty string for a field the document does not show.
- Give dates as YYYY-MM-DD. Give amounts as plain decimals with the printed decimals, without thousands separators or currency symbols, such as 1180.00.
- Keep text as printed: do not translate it or correct it.
- Give the currency as an ISO 4217 code and as printed. When no currency is printed, give the most likely one from the context, unless the tool's currency field says to leave it empty.
- Give every value a confidence from 0 to 1: how sure you are that it is what the document says.
- List line items in the order they are printed.`

export interface ExtractFile {
  bytes: Uint8Array
  mimeType: string
}

export interface Usage {
  input_tokens: number
  output_tokens: number
}

export interface ExtractResult {
  docType: DocType | 'not_supported'
  toolName: string
  /** The tool's input, validated again by the caller against the type's schema. */
  input: unknown
  usage: Usage
  raw: unknown
}

export interface ClaudeClient {
  extract(file: ExtractFile, docType: DocType | null): Promise<ExtractResult>
}

/** retryable: try again later (6.4). fatal: fail now. invalid_output: retried once, then fatal. */
export type ClaudeErrorKind = 'retryable' | 'fatal' | 'invalid_output'

export class ClaudeError extends Error {
  constructor(
    readonly kind: ClaudeErrorKind,
    /** A sentence the user can read. */
    readonly reason: string,
    readonly details: { status?: number; usage?: Usage; raw?: unknown; cause?: string } = {},
  ) {
    super(details.cause ? `${reason} ${details.cause}` : reason)
    this.name = 'ClaudeError'
  }

  get status() {
    return this.details.status
  }

  get usage() {
    return this.details.usage
  }
}

/** What the client needs of the SDK: messages.create. */
export interface MessagesApi {
  create(params: ExtractRequest): Promise<unknown>
}

export interface ExtractRequest {
  model: string
  max_tokens: number
  temperature: number
  system: string
  tools: ToolDefinition[]
  tool_choice: { type: 'auto' }
  messages: { role: 'user'; content: Record<string, unknown>[] }[]
}

export interface ClientOptions {
  /** app_config.model, or CLAUDE_MODEL where set (Lead ruling 4). */
  model: string
  /** app_config.max_output_tokens: the output part of the spend estimate is a limit (section 7). */
  maxTokens: number
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fileBlock(file: ExtractFile): Record<string, unknown> {
  const source = { type: 'base64', media_type: file.mimeType, data: base64(file.bytes) }
  return file.mimeType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source }
}

/**
 * The one request for a document: every type's tool and record_not_supported to detect the type,
 * or only the chosen type's tool (OQ-1); tool_choice auto in both cases.
 */
export function buildRequest(file: ExtractFile, docType: DocType | null, options: ClientOptions): ExtractRequest {
  const tools = toolsFor(docType)
  const ask = docType
    ? `Record this document with the ${tools[0].name} tool.`
    : 'Record this document by calling exactly one of the tools.'
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [fileBlock(file), { type: 'text', text: ask }] }],
  }
}

interface MessageResponse {
  content?: { type: string; name?: string; input?: unknown }[]
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Reads the answer: exactly one call of a tool that was sent, or a ClaudeError. */
export function readResponse(response: unknown, docType: DocType | null): ExtractResult {
  const message = response as MessageResponse
  const usage = { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: message.usage?.output_tokens ?? 0 }
  const invalid = (reason: string) => new ClaudeError('invalid_output', reason, { usage, raw: response })

  if (message.stop_reason === 'refusal') {
    throw new ClaudeError('fatal', 'Claude declined to read this document.', { usage, raw: response })
  }
  if (message.stop_reason === 'max_tokens') throw invalid('Claude’s answer was cut off.')
  const calls = (message.content ?? []).filter((block) => block.type === 'tool_use')
  if (calls.length === 0) throw invalid('Claude did not call a tool.')
  if (calls.length > 1) throw invalid('Claude called more than one tool.')

  const [call] = calls
  const offered = toolsFor(docType).map((t) => t.name)
  const type = call.name && offered.includes(call.name) ? docTypeOfTool(call.name) : null
  if (!type) throw invalid(`Claude called a tool that was not offered: ${call.name}.`)
  return { docType: type, toolName: call.name as string, input: call.input, usage, raw: response }
}

/** Sorts an SDK error by section 6.4: 429, 5xx, network errors and timeouts are retryable. */
export function classifyError(error: unknown): ClaudeError {
  if (error instanceof ClaudeError) return error
  const e = error as { status?: unknown; name?: string; message?: string }
  const cause = e?.message ?? String(error)
  if (typeof e?.status === 'number') {
    const status = e.status
    if (status === 429) return new ClaudeError('retryable', 'Claude’s rate limit was reached.', { status, cause })
    if (status === 529) return new ClaudeError('retryable', 'Claude was overloaded.', { status, cause })
    if (status >= 500 || status === 408) return new ClaudeError('retryable', 'Claude had a server error.', { status, cause })
    if (status === 400) {
      return new ClaudeError('fatal', 'Claude could not read this file. It may be damaged, password-protected or too large.', {
        status,
        cause,
      })
    }
    return new ClaudeError('fatal', `Claude refused the request (status ${status}).`, { status, cause })
  }
  if (e?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(cause)) {
    return new ClaudeError('retryable', 'Claude did not answer in time.', { cause })
  }
  return new ClaudeError('retryable', 'Claude could not be reached.', { cause })
}

export function createClaudeClient(api: MessagesApi, options: ClientOptions): ClaudeClient {
  return {
    async extract(file, docType) {
      let response: unknown
      try {
        response = await api.create(buildRequest(file, docType, options))
      } catch (error) {
        throw classifyError(error)
      }
      return readResponse(response, docType)
    },
  }
}
