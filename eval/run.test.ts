import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOC_TYPES, toolsFor } from '@shared/doctypes/index'
import { buildRequest, PROMPT_VERSION, type ExtractRequest, type MessagesApi } from '../supabase/functions/_shared/claude'
import { fixture } from '../supabase/functions/_shared/fake-claude'
import { expectedFile } from './make-documents'
import { main, toolInput, type EvalResults } from './run'
import type { ExpectedResult } from './score'
import { DOCUMENTS_DIR, EVAL_DOCUMENTS, EXPECTED_DIR } from './values'

// The runner end to end (issue #43 criteria 4, 6 and 8), with a fake Messages API in place of
// Claude, as supabase/functions/_shared/fake-claude.ts gives the app's tests: no network, no key.
// The fake answers each request with the document's expected result, unless told otherwise.

const NOW = new Date('2026-11-02T09:30:00Z')
const expected = new Map(
  EVAL_DOCUMENTS.map((d) => [d.file, JSON.parse(readFileSync(new URL(expectedFile(d), EXPECTED_DIR), 'utf8')) as ExpectedResult]),
)
const byData = new Map(EVAL_DOCUMENTS.map((d) => [Buffer.from(readFileSync(new URL(d.file, DOCUMENTS_DIR))).toString('base64'), d.file]))

type Answer = 'ok' | 'error-429' | 'error-529' | { input: unknown; tool?: string } | ((attempt: number) => Answer)

/** A fake Messages API: what it answers each document, by file name, and every request it was sent. */
function fakeApi(answers: Record<string, Answer> = {}) {
  const requests: { file: string; params: ExtractRequest }[] = []
  const api: MessagesApi = {
    async create(params) {
      const data = (params.messages[0].content[0] as { source: { data: string } }).source.data
      const file = byData.get(data) ?? 'unknown'
      requests.push({ file, params })
      const attempt = requests.filter((r) => r.file === file).length
      const settle = (a: Answer): Exclude<Answer, (attempt: number) => Answer> => (typeof a === 'function' ? settle(a(attempt)) : a)
      const answer = settle(answers[file] ?? 'ok')
      if (answer === 'error-429' || answer === 'error-529') {
        const f = fixture(answer)
        throw Object.assign(new Error(`${f.status} error`), { status: f.status, error: f.body })
      }
      const e = expected.get(file)!
      const input = answer === 'ok' ? toolInput(e, 0.95) : answer.input
      const tool = answer === 'ok' ? DOC_TYPES[e.doc_type].tool.name : (answer.tool ?? DOC_TYPES[e.doc_type].tool.name)
      return { content: [{ type: 'tool_use', name: tool, input }], stop_reason: 'tool_use', usage: { input_tokens: 3000, output_tokens: 700 } }
    },
  }
  return { api, requests }
}

let dir: string
let lines: string[]
const delays: number[] = []
const deps = (api: MessagesApi) => ({
  api,
  resultsDir: dir,
  now: () => NOW,
  sleep: async (ms: number) => {
    delays.push(ms)
  },
  log: (line: string) => lines.push(line),
})
const readResults = (name = '2026-11-02-claude-sonnet-5-5.json') => JSON.parse(readFileSync(join(dir, name), 'utf8')) as EvalResults

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-results-'))
  lines = []
  delays.length = 0
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('npm run eval', () => {
  it('refuses to start with no key, sending nothing and writing nothing', async () => {
    const { api, requests } = fakeApi()
    expect(await main(['--model', 'claude-sonnet-5-5'], {}, deps(api))).toBe(1)
    expect(await main([], { ANTHROPIC_API_KEY: '  ' }, deps(api))).toBe(1)
    expect(lines.join('\n')).toContain('ANTHROPIC_API_KEY')
    expect(requests).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses an unknown argument and a --model without a name', async () => {
    const { api, requests } = fakeApi()
    expect(await main(['--modle', 'x'], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(1)
    expect(await main(['--model'], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(1)
    expect(requests).toEqual([])
  })

  it('refuses when npm took --model for itself, as it does when the -- before it is lost, rather than run the default model', async () => {
    const { api, requests } = fakeApi()
    expect(await main([], { ANTHROPIC_API_KEY: 'k', npm_config_model: 'claude-haiku-5-5' }, deps(api))).toBe(1)
    expect(await main(['--dry-run'], { npm_config_model: 'claude-haiku-5-5' }, deps(api))).toBe(1)
    expect(lines.join('\n')).toContain('npm run eval -- --model claude-haiku-5-5')
    expect(requests).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('sends every document the app’s own request, with every type’s tool and record_not_supported, to claude-sonnet-5-5 by default', async () => {
    const { api, requests } = fakeApi()
    expect(await main([], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(0)
    expect(requests.map((r) => r.file).sort()).toEqual(EVAL_DOCUMENTS.map((d) => d.file).sort())
    for (const { file, params } of requests) {
      const bytes = new Uint8Array(readFileSync(new URL(file, DOCUMENTS_DIR)))
      const mimeType = file.endsWith('.png') ? 'image/png' : 'application/pdf'
      expect(params, file).toEqual(buildRequest({ bytes, mimeType }, null, { model: 'claude-sonnet-5-5', maxTokens: 8192 }))
      expect(params.tools.map((t) => t.name)).toEqual(toolsFor(null).map((t) => t.name))
      expect(params.tools.map((t) => t.name)).toContain('record_not_supported')
    }
  })

  it('writes eval/results/<date>-<model>.json in the documented shape, replacing a run of the same day', async () => {
    expect(await main([], { ANTHROPIC_API_KEY: 'k' }, deps(fakeApi().api))).toBe(0)
    expect(readdirSync(dir)).toEqual(['2026-11-02-claude-sonnet-5-5.json'])
    const r = readResults()
    expect(Object.keys(r)).toEqual(['date', 'model', 'prompt_version', 'settings', 'types', 'check_usefulness', 'usage', 'failed_documents', 'documents'])
    expect(r.date).toBe('2026-11-02')
    expect(r.model).toBe('claude-sonnet-5-5')
    expect(r.prompt_version).toBe(PROMPT_VERSION)
    expect(r.settings).toEqual({ max_tokens: 8192, temperature: 0, confidence_threshold: 0.8, amount_tolerance: '0.01', attempts: 3 })
    expect(Object.keys(r.types).sort()).toEqual(Object.keys(DOC_TYPES).sort())
    for (const t of Object.values(r.types)) {
      expect(t.documents).toBe(5)
      expect(t.header.accuracy).toBe(1)
      expect(t.header.meets_target).toBe(true)
      expect(t.type_detection).toEqual({ correct: 5, total: 5 })
      expect(t.header.target).toBeGreaterThan(0)
    }
    expect(r.types.invoice.line_items.target).toBe(0.9)
    expect(r.documents).toHaveLength(30)
    expect(r.documents[0]).toMatchObject({ document: 'invoice-01.pdf', doc_type: 'invoice', type_correct: true, misses: [], pages: 1 })
    expect(r.documents[0].confidence.vendor_name).toBe(0.95)
    expect(r.documents[0].usage).toEqual({ input_tokens: 3000, output_tokens: 700, attempts: 1 })
    expect(r.failed_documents).toEqual([])
    expect(r.check_usefulness).toEqual({ misread_totals: [], misread: 0, flagged: 0 })
    expect(r.usage).toMatchObject({ input_tokens: 90000, output_tokens: 21000, cost_usd: 0.39, prices_checked: '2026-10-31' })
    // The largest input per page is a one-page document's 3000; the three-page statement's is 1000.
    expect(r.usage.max_input_tokens_per_page).toBe(3000)
    expect(r.documents.find((d) => d.document === 'bank-statement-04.pdf')?.pages).toBe(3)
    expect(lines.join('\n')).toMatch(/invoice\s+5\s+100\.0%\s+\(≥ 95%\)/)

    // A second run the same day with the same model replaces the file.
    const { api } = fakeApi({ 'quote-01.pdf': { input: { nonsense: true } } })
    expect(await main([], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(0)
    expect(readdirSync(dir)).toEqual(['2026-11-02-claude-sonnet-5-5.json'])
    expect(readResults().failed_documents).toEqual(['quote-01.pdf'])
  })

  it('names the file after --model and sends that model', async () => {
    const { api, requests } = fakeApi()
    expect(await main(['--model', 'claude-haiku-5-5'], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(0)
    expect(new Set(requests.map((r) => r.params.model))).toEqual(new Set(['claude-haiku-5-5']))
    expect(readResults('2026-11-02-claude-haiku-5-5.json').usage.cost_usd).toBe(0.0195)
  })

  it('retries a 429 or a 529, then counts a document that keeps failing as all misses and lists it', async () => {
    const { api, requests } = fakeApi({
      'receipt-01.png': (attempt) => (attempt === 1 ? 'error-429' : 'ok'),
      'invoice-02.pdf': 'error-529',
    })
    expect(await main([], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(0)
    expect(requests.filter((r) => r.file === 'receipt-01.png')).toHaveLength(2)
    expect(requests.filter((r) => r.file === 'invoice-02.pdf')).toHaveLength(3)
    // Invoices go first: invoice-02 waits 10 s and 30 s before its second and third attempts.
    expect(delays).toEqual([10_000, 30_000, 10_000])

    const r = readResults()
    const receipt = r.documents.find((d) => d.document === 'receipt-01.png')!
    expect(receipt.misses).toEqual([])
    expect(receipt.usage.attempts).toBe(2)
    const failed = r.documents.find((d) => d.document === 'invoice-02.pdf')!
    expect(failed.outcome).toBe('failed')
    expect(failed.error).toContain('overloaded')
    expect(failed.header.correct + failed.line_items.correct).toBe(0)
    expect(failed.misses).toHaveLength(expected.get('invoice-02.pdf')!.fields.length)
    expect(r.failed_documents).toEqual(['invoice-02.pdf'])
    expect(r.types.invoice.header.correct).toBe(r.types.invoice.header.total - failed.header.total)
    expect(r.types.invoice.type_detection).toEqual({ correct: 4, total: 5 })
    expect(lines.join('\n')).toContain('invoice-02.pdf')
  })

  it('reports each misread total or subtotal and whether a check flagged it, and the confident misses', async () => {
    const quote = expected.get('quote-02.pdf')!
    const misread = toolInput(quote, 0.9) as Record<string, { value: string; confidence: number }>
    misread.total = { value: '4200.00', confidence: 0.97 }
    // The receipt recorded as an invoice: a valid invoice, so the app would store it.
    const asInvoice = toolInput(expected.get('invoice-05.pdf')!, 0.9)
    const { api } = fakeApi({
      'quote-02.pdf': { input: misread },
      'receipt-05.pdf': { input: asInvoice, tool: 'record_invoice' },
      'delivery-note-03.pdf': { input: { reason: 'A letter.' }, tool: 'record_not_supported' },
    })
    expect(await main([], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(0)
    const r = readResults()
    const total = quote.fields.find((f) => f.path === 'total')!.value
    expect(r.check_usefulness).toEqual({
      misread_totals: [{ document: 'quote-02.pdf', path: 'total', expected: total, got: '4200.00', flagged: true, checks: ['A3'] }],
      misread: 1,
      flagged: 1,
    })
    const q = r.documents.find((d) => d.document === 'quote-02.pdf')!
    expect(q.misses).toEqual([{ path: 'total', expected: total, got: '4200.00', confidence: 0.97 }])
    expect(q.confident_misses).toBe(1)

    const wrong = r.documents.find((d) => d.document === 'receipt-05.pdf')!
    expect(wrong).toMatchObject({ detected_type: 'invoice', type_correct: false, outcome: 'ok' })
    expect(wrong.header.correct + wrong.line_items.correct).toBe(0)
    expect(r.types.receipt.type_detection).toEqual({ correct: 4, total: 5 })
    const unsupported = r.documents.find((d) => d.document === 'delivery-note-03.pdf')!
    expect(unsupported).toMatchObject({ detected_type: 'not_supported', outcome: 'not_supported', type_correct: false })
    expect(r.failed_documents).toEqual([])
  })

  it('retries an answer that fails the app’s validation once, as the app does, then counts the document as failed', async () => {
    const { api, requests } = fakeApi({ 'purchase-order-03.pdf': { input: { po_number: 'x' } } })
    expect(await main([], { ANTHROPIC_API_KEY: 'k' }, deps(api))).toBe(0)
    expect(requests.filter((r) => r.file === 'purchase-order-03.pdf')).toHaveLength(2)
    const po = readResults().documents.find((d) => d.document === 'purchase-order-03.pdf')!
    expect(po.outcome).toBe('failed')
    expect(po.error).toContain('did not match its schema')
  })

  it('with --dry-run builds every request and prints the token and cost estimate, with no key and no call', async () => {
    const { api, requests } = fakeApi()
    expect(await main(['--dry-run'], {}, deps(api))).toBe(0)
    expect(requests).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    const out = lines.join('\n')
    expect(out).toContain('30 requests built')
    expect(out).toMatch(/Estimated input tokens\s+[\d,]+/)
    expect(out).toMatch(/Estimated output tokens\s+[\d,]+/)
    expect(out).toMatch(/Estimated cost at claude-sonnet-5-5 prices\s+USD \d+\.\d{2}/)
    expect(out).toContain('bank-statement-04.pdf')
  })
})
