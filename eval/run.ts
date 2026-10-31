import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { utcDate } from '../shared/doctypes/checks.ts'
import type { CheckResult, FieldRow } from '../shared/doctypes/fields.ts'
import { DOC_TYPES, prepareResult, type DocType } from '../shared/doctypes/index.ts'
import {
  buildRequest,
  ClaudeError,
  createClaudeClient,
  PROMPT_VERSION,
  type ClaudeClient,
  type ExtractFile,
  type MessagesApi,
  type Usage,
} from '../supabase/functions/_shared/claude.ts'
import { expectedFile } from './make-documents.ts'
import { costUsd, PRICES } from './prices.ts'
import { scoreDocument, scoreRun, TARGETS, TOTALS, type DocumentScore, type ExpectedResult, type Extraction, type TypeScore } from './score.ts'
import { DOCUMENTS_DIR, EVAL_DOCUMENTS, EXPECTED_DIR } from './values.ts'

// The eval runner (PRD F16, issue #43 criteria 4 to 6, Lead rulings 1 to 4): `npm run eval --
// --model <model>` sends each eval document to Claude with the request the app sends (buildRequest,
// every type's tool and record_not_supported, so the type is detected), validates the answer as
// the app does before storing it (prepareResult), scores it against eval/expected/, and writes
// eval/results/<yyyy-mm-dd>-<model>.json. The operator runs it by hand with their own key; it never
// touches the database or the spend tables, and nothing runs it on its own. `--dry-run` builds every
// request and prints a token and cost estimate without calling the API, and needs no key.

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/**
 * app_config's values as the queue milestone set them (supabase/migrations/20261031091312_extract_queue.sql):
 * the runner reads no database, so it carries the defaults the app runs with.
 */
export const SETTINGS = { max_tokens: 8192, temperature: 0, confidence_threshold: 0.8, amount_tolerance: '0.01', attempts: 3 } as const

/** Waits before the second and third attempt after a 429, a 529 or another retryable error. */
export const RETRY_DELAYS_MS = [10_000, 30_000]

export const RESULTS_DIR = new URL('./results/', import.meta.url)

interface EvalDocumentFile {
  expected: ExpectedResult
  file: ExtractFile
  pages: number
}

export interface DocumentResult extends DocumentScore {
  pages: number
  usage: Usage & { attempts: number }
}

export interface MisreadTotal {
  document: string
  path: string
  expected: string | null
  got: string | null
  /** Whether the app flagged the field check_failed. */
  flagged: boolean
  /** The arithmetic checks that failed naming the field. */
  checks: string[]
}

/** One run's file in eval/results/, as eval/README.md documents it. */
export interface EvalResults {
  date: string
  model: string
  prompt_version: string
  settings: typeof SETTINGS
  types: Record<DocType, TypeScore>
  check_usefulness: { misread_totals: MisreadTotal[]; misread: number; flagged: number }
  usage: { input_tokens: number; output_tokens: number; max_input_tokens_per_page: number; cost_usd: number | null; prices_checked: string | null }
  failed_documents: string[]
  documents: DocumentResult[]
}

export interface RunDeps {
  /** The Messages API; the real one, with the key, when none is given. */
  api?: MessagesApi
  /** Where results are written; eval/results/ when none is given. */
  resultsDir?: string
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

/** A tool input that records exactly what an expected result holds, at one confidence. */
export function toolInput(expected: ExpectedResult, confidence = 1): Record<string, unknown> {
  const def = DOC_TYPES[expected.doc_type]
  const value = new Map(expected.fields.map((f) => [f.path, f.value]))
  const field = (path: string) => ({ value: value.get(path) ?? '', confidence })
  const count = new Set(expected.fields.map((f) => /^line_items\[(\d+)\]/.exec(f.path)?.[1]).filter((i) => i !== undefined)).size
  return {
    ...Object.fromEntries(def.fields.map((f) => [f.name, field(f.name)])),
    [def.linesKey]: Array.from({ length: count }, (_, i) => Object.fromEntries(def.lineFields.map((f) => [f.name, field(`line_items[${i}].${f.name}`)]))),
  }
}

const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

/** The 30 documents, their expected results and page counts, in values.ts's order. */
async function loadDocuments(): Promise<EvalDocumentFile[]> {
  return Promise.all(
    EVAL_DOCUMENTS.map(async (d) => {
      const expected = JSON.parse(readFileSync(new URL(expectedFile(d), EXPECTED_DIR), 'utf8')) as ExpectedResult
      const bytes = new Uint8Array(readFileSync(new URL(d.file, DOCUMENTS_DIR)))
      const mimeType = MIME[d.file.split('.').pop() as string]
      const pages = mimeType === 'application/pdf' ? (await PDFDocument.load(bytes)).getPageCount() : 1
      return { expected, file: { bytes, mimeType }, pages }
    }),
  )
}

/** The Messages API over fetch, as the SDK sends it, with an error carrying the status as the SDK's does. */
export function anthropicApi(apiKey: string, baseUrl: string): MessagesApi {
  return {
    async create(params) {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(120_000),
      })
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      if (!response.ok) {
        throw Object.assign(new Error(`${response.status} ${body?.error?.message ?? response.statusText}`), { status: response.status, error: body })
      }
      return body
    },
  }
}

interface Extracted {
  extraction: Extraction
  rows: FieldRow[]
  checks: CheckResult[]
  usage: Usage & { attempts: number }
  /** The largest input tokens per page of any answer. */
  perPage: number
}

/**
 * One document through Claude and the app's validation. Retryable errors (429, 529, 5xx, network)
 * wait and try again up to SETTINGS.attempts in all; an invalid answer, including one that fails
 * validation, is tried once more, as process-queue does (section 6.4); then the document fails.
 */
async function extractOne(client: ClaudeClient, doc: EvalDocumentFile, today: string, sleep: (ms: number) => Promise<void>): Promise<Extracted> {
  const usage = { input_tokens: 0, output_tokens: 0, attempts: 0 }
  let perPage = 0
  const count = (u: Usage | undefined) => {
    if (!u) return
    usage.input_tokens += u.input_tokens
    usage.output_tokens += u.output_tokens
    perPage = Math.max(perPage, Math.ceil(u.input_tokens / doc.pages))
  }
  const done = (extraction: Extraction, rows: FieldRow[] = [], checks: CheckResult[] = []) => ({ extraction, rows, checks, usage, perPage })
  let invalid = 0

  for (;;) {
    usage.attempts += 1
    try {
      const result = await client.extract(doc.file, null)
      count(result.usage)
      if (result.docType === 'not_supported') {
        const reason = (result.input as { reason?: unknown } | null)?.reason
        if (typeof reason !== 'string') throw new ClaudeError('invalid_output', 'record_not_supported had no reason.')
        return done({ outcome: 'not_supported', reason })
      }
      const prepared = prepareResult(result.docType, result.input, {
        confidenceThreshold: SETTINGS.confidence_threshold,
        amountTolerance: SETTINGS.amount_tolerance,
        today,
      })
      if (!prepared.ok) throw new ClaudeError('invalid_output', `The ${result.toolName} input did not match its schema: ${prepared.errors.join('; ')}`)
      return done({ outcome: 'ok', doc_type: result.docType, fields: prepared.fields }, prepared.fields, prepared.checks)
    } catch (error) {
      if (!(error instanceof ClaudeError)) throw error
      count(error.usage)
      if (error.kind === 'invalid_output') invalid += 1
      const last = usage.attempts >= SETTINGS.attempts || error.kind === 'fatal' || invalid >= 2
      if (last) return done({ outcome: 'failed', error: error.message })
      if (error.kind === 'retryable') await sleep(RETRY_DELAYS_MS[usage.attempts - 1])
    }
  }
}

/** Every total or subtotal the extraction got wrong, and whether a check flagged it (PRD section 10). */
function misreadTotals(score: DocumentScore, rows: FieldRow[], checks: CheckResult[]): MisreadTotal[] {
  if (score.outcome !== 'ok' || !score.type_correct) return []
  return score.misses
    .filter((m) => TOTALS[score.doc_type].includes(m.path) && m.expected !== null)
    .map((m) => ({
      document: score.document,
      path: m.path,
      expected: m.expected,
      got: m.got,
      flagged: rows.find((r) => r.path === m.path)?.flags.includes('check_failed') ?? false,
      checks: checks.filter((c) => c.check_id.startsWith('A') && c.status === 'fail' && c.field_paths.includes(m.path)).map((c) => c.check_id),
    }))
}

const percent = (value: number | null) => (value === null ? '   n/a' : `${(value * 100).toFixed(1)}%`.padStart(6))
const thousands = (n: number) => n.toLocaleString('en-US')

/** The summary table the runner prints. */
function summary(r: EvalResults): string[] {
  const out = [
    '',
    `Eval of ${r.model}, prompt ${r.prompt_version}, ${r.date}`,
    '',
    `${'Type'.padEnd(16)} Docs  Header fields      Line items         Type detected`,
  ]
  for (const [type, t] of Object.entries(r.types) as [DocType, TypeScore][]) {
    const target = (v: number) => `(≥ ${Math.round(v * 100)}%)`
    out.push(
      `${type.padEnd(16)} ${String(t.documents).padStart(4)}  ${percent(t.header.accuracy)} ${target(TARGETS[type].header).padEnd(10)} ` +
        `${percent(t.line_items.accuracy)} ${target(TARGETS[type].line_items).padEnd(10)} ${t.type_detection.correct}/${t.type_detection.total}`,
    )
  }
  const cu = r.check_usefulness
  out.push(
    '',
    `Misread totals and subtotals flagged by a check: ${cu.flagged} of ${cu.misread}`,
    ...cu.misread_totals.map((m) => `  ${m.document} ${m.path}: expected ${m.expected}, got ${m.got ?? '(nothing)'}${m.flagged ? `, flagged by ${m.checks.join(', ')}` : ', NOT flagged'}`),
    `Confident misses (confidence ≥ 0.8): ${r.documents.reduce((n, d) => n + d.confident_misses, 0)}`,
    `Failed documents: ${r.failed_documents.length ? r.failed_documents.join(', ') : 'none'}`,
    `Tokens: ${thousands(r.usage.input_tokens)} in, ${thousands(r.usage.output_tokens)} out; largest input per page ${thousands(r.usage.max_input_tokens_per_page)}`,
    r.usage.cost_usd === null ? `Cost: no price recorded for ${r.model} in eval/prices.ts` : `Cost: USD ${r.usage.cost_usd.toFixed(4)} (prices checked ${r.usage.prices_checked})`,
  )
  return out
}

/** Characters per token for the estimate: low, so it errs high. */
const CHARS_PER_TOKEN = 3.5
/** The system prompt the API adds for tool use. */
const TOOL_USE_TOKENS = 350
/** A PDF page, as text and as an image, at the high end of Anthropic's guidance. */
const PDF_PAGE_TOKENS = 3000

/** An image's tokens: width × height / 750, after the API scales it to at most 1568 px a side and 1.15 megapixels. */
function imageTokens(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const png = bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (!png) return 1600
  const w = view.getUint32(16)
  const h = view.getUint32(20)
  const scale = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)))
  return Math.ceil((w * scale * (h * scale)) / 750)
}

/** --dry-run: every request built as the run would send it, and an estimate of its tokens and cost. */
function dryRun(docs: EvalDocumentFile[], model: string, log: (line: string) => void) {
  let input = 0
  let output = 0
  let perPage = 0
  log(`${'Document'.padEnd(24)} Pages  Input tokens  Output tokens`)
  for (const doc of docs) {
    const request = buildRequest(doc.file, null, { model, maxTokens: SETTINGS.max_tokens })
    const text = request.system + JSON.stringify(request.tools) + JSON.stringify(request.messages[0].content.filter((b) => b.type === 'text'))
    const fileTokens = doc.file.mimeType === 'application/pdf' ? doc.pages * PDF_PAGE_TOKENS : imageTokens(doc.file.bytes)
    const docInput = Math.ceil(text.length / CHARS_PER_TOKEN) + TOOL_USE_TOKENS + fileTokens
    const docOutput = Math.ceil(JSON.stringify(toolInput(doc.expected, 0.95)).length / CHARS_PER_TOKEN) + 50
    input += docInput
    output += docOutput
    perPage = Math.max(perPage, Math.ceil(docInput / doc.pages))
    log(`${doc.expected.document.padEnd(24)} ${String(doc.pages).padStart(5)}  ${thousands(docInput).padStart(12)}  ${thousands(docOutput).padStart(13)}`)
  }
  const cost = costUsd(model, input, output)
  log('')
  log(`${docs.length} requests built for ${model}, prompt ${PROMPT_VERSION}; nothing was sent.`)
  log(`Estimated input tokens   ${thousands(input)}`)
  log(`Estimated output tokens  ${thousands(output)}`)
  log(`Estimated largest input per page  ${thousands(perPage)}`)
  log(
    cost === null
      ? `No price recorded for ${model} in eval/prices.ts.`
      : `Estimated cost at ${model} prices  USD ${cost.toFixed(2)} (prices checked ${PRICES[model].checked})`,
  )
}

/** The arguments: --model <model> or --model=<model>, and --dry-run; an error message for anything else. */
export function parseArgs(argv: string[]): { model: string; dryRun: boolean } | { error: string } {
  let model = DEFAULT_MODEL
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--model' || arg.startsWith('--model=')) {
      const value = arg === '--model' ? argv[++i] : arg.slice('--model='.length)
      if (!value || !/^[a-z0-9][a-z0-9.-]*$/i.test(value)) return { error: '--model needs a model name, such as claude-haiku-5-5.' }
      model = value
    } else return { error: `Unknown argument ${arg}. Use --model <model> and --dry-run.` }
  }
  return { model, dryRun }
}

/** Runs the eval; returns the process's exit code. */
export async function main(argv: string[], env: Record<string, string | undefined>, deps: RunDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const args = parseArgs(argv)
  if ('error' in args) {
    log(args.error)
    return 1
  }
  // Without the -- (PowerShell's npm shim can drop it), npm keeps --model as its own setting and
  // the run would quietly use the default model.
  const npmModel = env.npm_config_model?.trim()
  if (npmModel && !argv.some((a) => a.startsWith('--model'))) {
    log(`npm kept --model ${npmModel} for itself. Put -- before the runner's arguments: npm run eval -- --model ${npmModel}`)
    return 1
  }
  const docs = await loadDocuments()
  if (args.dryRun) {
    dryRun(docs, args.model, log)
    return 0
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) {
    log('ANTHROPIC_API_KEY is not set. Set it to your own Anthropic API key (eval/README.md), or use --dry-run for an estimate.')
    return 1
  }
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com'
  const client = createClaudeClient(deps.api ?? anthropicApi(apiKey, baseUrl), { model: args.model, maxTokens: SETTINGS.max_tokens })
  const now = (deps.now ?? (() => new Date()))()
  const today = utcDate(now)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  log(`Running ${docs.length} documents through ${args.model} at ${baseUrl}, one at a time.`)

  const documents: DocumentResult[] = []
  const misread: MisreadTotal[] = []
  let perPage = 0
  for (const [i, doc] of docs.entries()) {
    const x = await extractOne(client, doc, today, sleep)
    const score = scoreDocument(doc.expected, x.extraction)
    documents.push({ ...score, pages: doc.pages, usage: x.usage })
    misread.push(...misreadTotals(score, x.rows, x.checks))
    perPage = Math.max(perPage, x.perPage)
    const what =
      score.outcome === 'failed'
        ? `FAILED: ${score.error}`
        : `${score.detected_type}${score.type_correct ? '' : ' (WRONG TYPE)'}, header ${score.header.correct}/${score.header.total}, line items ${score.line_items.correct}/${score.line_items.total}`
    log(`[${i + 1}/${docs.length}] ${doc.expected.document}: ${what}`)
  }

  const input = documents.reduce((n, d) => n + d.usage.input_tokens, 0)
  const output = documents.reduce((n, d) => n + d.usage.output_tokens, 0)
  const results: EvalResults = {
    date: today,
    model: args.model,
    prompt_version: PROMPT_VERSION,
    settings: SETTINGS,
    types: scoreRun(documents) as Record<DocType, TypeScore>,
    check_usefulness: { misread_totals: misread, misread: misread.length, flagged: misread.filter((m) => m.flagged).length },
    usage: {
      input_tokens: input,
      output_tokens: output,
      max_input_tokens_per_page: perPage,
      cost_usd: costUsd(args.model, input, output),
      prices_checked: PRICES[args.model]?.checked ?? null,
    },
    failed_documents: documents.filter((d) => d.outcome === 'failed').map((d) => d.document),
    documents,
  }

  const dir = deps.resultsDir ?? fileURLToPath(RESULTS_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${today}-${args.model}.json`)
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`)
  for (const line of summary(results)) log(line)
  log('')
  log(`Results written to ${path}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env)
}
