import { describe, expect, it } from 'vitest'
import { createClaudeClient, type ClaudeClient } from '../_shared/claude'
import { fixtureApi } from '../_shared/fake-claude'
import {
  estimateCost,
  processQueue,
  waitingReason,
  type AppConfig,
  type ExtractionRecord,
  type ProcessDeps,
  type QueuedDocument,
} from './process'

// process-queue's steps (ARCHITECTURE.md sections 6.3 and 6.4, PRD US-1.1 AC-7, US-1.2 AC-1 and
// AC-2, US-2.1 AC-6, US-12.1 AC-2, OQ-1, OQ-10, OQ-23), with the database and Storage behind
// ProcessDeps and Claude replaced by recorded responses: no network, no real API.

const DOC = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-31T12:00:00Z')

const CONFIG: AppConfig = {
  model: 'claude-sonnet-5-5',
  input_usd_per_mtok: 2,
  output_usd_per_mtok: 10,
  base_input_tokens: 4000,
  max_input_tokens_per_page: 5000,
  max_output_tokens: 8192,
  confidence_threshold: 0.8,
  amount_tolerance: 0.01,
}

interface Fake extends ProcessDeps {
  calls: string[]
  records: ExtractionRecord[]
  waiting: string | null
  delayed: number | null
  started: number | null
  extractedWith: { docType: string | null; mimeType: string; model: string } | null
}

interface Options {
  doc?: Partial<QueuedDocument> | null
  message?: { document_id?: unknown } | null
  claude?: string[]
  refusedBy?: 'daily' | 'monthly' | null
  priorInvalidOutputs?: number
  file?: Uint8Array | null
  recordResult?: string
  modelOverride?: string | null
}

function fake(o: Options = {}): Fake {
  const doc: QueuedDocument | null =
    o.doc === null
      ? null
      : {
          id: DOC,
          status: 'queued',
          attempts: 0,
          page_count: 2,
          mime_type: 'application/pdf',
          storage_path: `ws/${DOC}/original`,
          doc_type: null,
          doc_type_source: null,
          processing_started_at: null,
          file_deleted_at: null,
          ...o.doc,
        }
  const f: Fake = {
    calls: [],
    records: [],
    waiting: null,
    delayed: null,
    started: null,
    extractedWith: null,
    modelOverride: o.modelOverride ?? null,
    now: () => NOW,
    read: async () => (o.message === null ? null : { msg_id: 7, read_ct: 1, message: o.message ?? { document_id: DOC } }),
    archive: async () => {
      f.calls.push('archive')
    },
    delay: async (_msg, seconds) => {
      f.calls.push('delay')
      f.delayed = seconds
    },
    loadDocument: async () => doc,
    config: async () => CONFIG,
    priorInvalidOutputs: async () => o.priorInvalidOutputs ?? 0,
    reserveSpend: async () => {
      f.calls.push('reserveSpend')
      return o.refusedBy ? { reservation: null, refused_by: o.refusedBy } : { reservation: 'res-1', refused_by: null }
    },
    setWaiting: async (_id, reason) => {
      f.calls.push('setWaiting')
      f.waiting = reason
    },
    startProcessing: async (_id, attempts) => {
      f.calls.push('startProcessing')
      f.started = attempts
    },
    download: async () => (o.file === undefined ? new TextEncoder().encode('%PDF-1.7') : o.file),
    claude: (model, maxTokens): ClaudeClient => {
      const client = createClaudeClient(fixtureApi(...(o.claude ?? ['invoice'])), { model, maxTokens })
      return {
        async extract(file, docType) {
          f.calls.push('claude')
          f.extractedWith = { docType, mimeType: file.mimeType, model }
          return client.extract(file, docType)
        },
      }
    },
    record: async (_id, reservation, result) => {
      f.calls.push('record')
      expect(reservation).toBe(f.calls.includes('reserveSpend') ? 'res-1' : null)
      f.records.push(result)
      return o.recordResult ?? 'recorded'
    },
  }
  return f
}

describe('estimateCost', () => {
  it('is the upper bound of section 7: input for the pages plus max_tokens of output', () => {
    // (4000 + 2 × 5000) × 2 / 1e6 + 8192 × 10 / 1e6
    expect(estimateCost(CONFIG, 2)).toBeCloseTo(0.10992, 10)
  })
})

describe('waitingReason', () => {
  it('names the limit and when it resets, in UTC', () => {
    expect(waitingReason('daily', NOW)).toBe(
      'The daily AI spending limit is reached. It resets at 00:00 UTC on 1 November 2026, when processing resumes.',
    )
    expect(waitingReason('monthly', NOW)).toBe(
      'The monthly AI spending limit is reached. It resets at 00:00 UTC on 1 November 2026, when processing resumes.',
    )
    expect(waitingReason('monthly', new Date('2026-12-15T00:00:00Z'))).toContain('1 January 2027')
  })
})

describe('processQueue', () => {
  it('does nothing when the queue is empty', async () => {
    const deps = fake({ message: null })
    expect(await processQueue(deps)).toEqual({ outcome: 'empty' })
    expect(deps.calls).toEqual([])
  })

  it('archives and skips a message for a document in another status, or deleted', async () => {
    for (const doc of [{ status: 'needs_review' }, { status: 'failed' }, { status: 'approved' }, null]) {
      const deps = fake({ doc })
      expect((await processQueue(deps)).outcome).toBe('skipped')
      expect(deps.calls).toEqual(['archive'])
    }
    const bad = fake({ message: { document_id: 'not-a-uuid' } })
    expect((await processQueue(bad)).outcome).toBe('skipped')
    expect(bad.calls).toEqual(['archive'])
  })

  it('leaves a document another run is processing until that run would count as killed, then takes it over', async () => {
    // Started 5 minutes ago: the message comes back when 10 minutes have passed, not archived, so
    // a run killed mid-call (section 6.4) is still picked up.
    const fresh = fake({ doc: { status: 'processing', processing_started_at: '2026-10-31T11:55:00Z', attempts: 1 } })
    expect((await processQueue(fresh)).outcome).toBe('skipped')
    expect(fresh.calls).toEqual(['delay'])
    expect(fresh.delayed).toBe(301)

    const stale = fake({ doc: { status: 'processing', processing_started_at: '2026-10-31T11:49:00Z', attempts: 1 } })
    expect((await processQueue(stale)).outcome).toBe('needs_review')
    expect(stale.started).toBe(2)
  })

  it('fails a document whose run was killed on its last attempt, with no spend reserved and no Claude call', async () => {
    const deps = fake({ doc: { status: 'processing', processing_started_at: '2026-10-31T11:49:00Z', attempts: 3 } })
    expect(await processQueue(deps)).toEqual({ outcome: 'failed', document_id: DOC })
    expect(deps.calls).toEqual(['record', 'archive'])
    expect(deps.calls).not.toContain('reserveSpend')
    expect(deps.calls).not.toContain('claude')
    expect(deps.started).toBeNull()
    expect(deps.records).toHaveLength(1)
    expect(deps.records[0]).toMatchObject({
      status: 'failed',
      status_reason: 'Extraction failed 3 times. The last time, the run did not finish. Retry later.',
      cost_usd: 0,
    })
  })

  it('at a cap: waiting_budget naming the limit, the message delayed 600 s, no attempt, no Claude call', async () => {
    for (const refusedBy of ['daily', 'monthly'] as const) {
      const deps = fake({ refusedBy })
      expect(await processQueue(deps)).toEqual({ outcome: 'waiting', document_id: DOC })
      expect(deps.calls).toEqual(['reserveSpend', 'setWaiting', 'delay'])
      expect(deps.waiting).toBe(waitingReason(refusedBy, NOW))
      expect(deps.delayed).toBe(600)
      expect(deps.started).toBeNull()
      expect(deps.records).toEqual([])
    }
  })

  it('resumes a waiting document with no user action once budget is available', async () => {
    const deps = fake({ doc: { status: 'waiting_budget', status_reason: 'The daily AI spending limit is reached.' } as Partial<QueuedDocument> })
    expect((await processQueue(deps)).outcome).toBe('needs_review')
    expect(deps.calls).toEqual(['reserveSpend', 'startProcessing', 'claude', 'record', 'archive'])
  })

  it('stores an invoice: processing, one Claude call with the type to detect, needs_review through record_extraction, archived', async () => {
    const deps = fake()
    expect(await processQueue(deps)).toEqual({ outcome: 'needs_review', document_id: DOC })
    expect(deps.calls).toEqual(['reserveSpend', 'startProcessing', 'claude', 'record', 'archive'])
    expect(deps.started).toBe(1)
    expect(deps.extractedWith).toEqual({ docType: null, mimeType: 'application/pdf', model: 'claude-sonnet-5-5' })
    const [record] = deps.records
    expect(record).toMatchObject({
      outcome: 'ok',
      status: 'needs_review',
      doc_type: 'invoice',
      tool_name: 'record_invoice',
      model: 'claude-sonnet-5-5',
      input_tokens: 2400,
      output_tokens: 1100,
    })
    // 2400 × 2 / 1e6 + 1100 × 10 / 1e6
    expect(record.cost_usd).toBeCloseTo(0.0158, 10)
    expect(record.prompt_version).toMatch(/\S/)
    expect(record.checks?.map((c) => [c.check_id, c.status])).toEqual([
      ['A1', 'pass'],
      ['A2', 'pass'],
      ['A3', 'pass'],
      ['A4', 'skipped'],
    ])
    expect(record.fields?.find((r) => r.path === 'vendor_name')?.flags).toEqual(['low_confidence'])
    expect(record.fields?.find((r) => r.path === 'line_items[1].amount')?.extracted_value).toBe('200.00')
  })

  it('uses CLAUDE_MODEL over app_config.model when it is set (Lead ruling 4)', async () => {
    const deps = fake({ modelOverride: 'claude-haiku-5-5' })
    await processQueue(deps)
    expect(deps.extractedWith?.model).toBe('claude-haiku-5-5')
    expect(deps.records[0].model).toBe('claude-haiku-5-5')
  })

  it('sends only the chosen type’s tool when the user chose the type', async () => {
    const deps = fake({ doc: { doc_type: 'invoice', doc_type_source: 'user' } })
    await processQueue(deps)
    expect(deps.extractedWith?.docType).toBe('invoice')
  })

  it('stores not supported: status unsupported with Claude’s reason, archived (OQ-1)', async () => {
    const deps = fake({ claude: ['not-supported'] })
    expect((await processQueue(deps)).outcome).toBe('unsupported')
    expect(deps.records[0]).toMatchObject({
      outcome: 'unsupported',
      status: 'unsupported',
      tool_name: 'record_not_supported',
      status_reason: 'Not a supported document type: This is a cover letter, not a business document.',
    })
    expect(deps.records[0].fields).toBeUndefined()
    expect(deps.calls.at(-1)).toBe('archive')
  })

  it.each([
    ['error-429', 'Claude’s rate limit was reached.'],
    ['error-500', 'Claude had a server error.'],
    ['error-529', 'Claude was overloaded.'],
    ['network-error', 'Claude could not be reached.'],
    ['timeout', 'Claude did not answer in time.'],
  ])('%s is retryable: the attempt is recorded, back to queued, the message left to reappear', async (fixture, reason) => {
    const deps = fake({ claude: [fixture] })
    expect((await processQueue(deps)).outcome).toBe('retry')
    expect(deps.records[0]).toMatchObject({ outcome: 'retryable_error', status: 'queued', error: expect.stringContaining(reason), cost_usd: 0 })
    expect(deps.calls).not.toContain('archive')
  })

  it('a third failed attempt is fatal: failed with a readable reason, archived', async () => {
    const deps = fake({ doc: { attempts: 2 }, claude: ['error-529'] })
    expect((await processQueue(deps)).outcome).toBe('failed')
    expect(deps.started).toBe(3)
    expect(deps.records[0]).toMatchObject({
      outcome: 'retryable_error',
      status: 'failed',
      status_reason: 'Extraction failed 3 times. The last time, Claude was overloaded. Retry later.',
    })
    expect(deps.calls.at(-1)).toBe('archive')
  })

  it('a 400 is fatal at once', async () => {
    const deps = fake({ claude: ['error-400'] })
    expect((await processQueue(deps)).outcome).toBe('failed')
    expect(deps.records[0]).toMatchObject({
      outcome: 'fatal_error',
      status: 'failed',
      status_reason: 'Claude could not read this file. It may be damaged, password-protected or too large.',
    })
    expect(deps.calls.at(-1)).toBe('archive')
  })

  it('a refusal is fatal at once', async () => {
    const deps = fake({ claude: ['refusal'] })
    expect((await processQueue(deps)).outcome).toBe('failed')
    expect(deps.records[0]).toMatchObject({ outcome: 'fatal_error', status: 'failed', status_reason: 'Claude declined to read this document.' })
  })

  it.each(['invalid-output', 'no-tool-call', 'two-tool-calls'])(
    'a first invalid output (%s) is retried; its usage is still paid for',
    async (fixture) => {
      const deps = fake({ claude: [fixture] })
      expect((await processQueue(deps)).outcome).toBe('retry')
      expect(deps.records[0]).toMatchObject({ outcome: 'invalid_output', status: 'queued' })
      expect(deps.records[0].cost_usd).toBeGreaterThan(0)
      expect(deps.calls).not.toContain('archive')
    },
  )

  it('a second invalid output is fatal', async () => {
    const deps = fake({ claude: ['invalid-output'], priorInvalidOutputs: 1, doc: { attempts: 1 } })
    expect((await processQueue(deps)).outcome).toBe('failed')
    expect(deps.records[0]).toMatchObject({
      outcome: 'invalid_output',
      status: 'failed',
      status_reason: 'Claude’s answer did not have the expected form, twice. Retry later.',
    })
    expect(deps.calls.at(-1)).toBe('archive')
  })

  it('a file missing from Storage is retried, or fails when it was deleted', async () => {
    const missing = fake({ file: null })
    expect((await processQueue(missing)).outcome).toBe('retry')
    expect(missing.records[0]).toMatchObject({ outcome: 'retryable_error', status: 'queued', cost_usd: 0 })
    expect(missing.calls).not.toContain('claude')

    const deleted = fake({ file: null, doc: { file_deleted_at: '2026-10-30T00:00:00Z' } })
    expect((await processQueue(deleted)).outcome).toBe('failed')
    expect(deleted.records[0]).toMatchObject({ status: 'failed', status_reason: 'The file was deleted before it could be read.' })
  })

  it('archives the message when the document was deleted during the call', async () => {
    const deps = fake({ claude: ['error-529'], recordResult: 'deleted' })
    await processQueue(deps)
    expect(deps.calls.at(-1)).toBe('archive')
  })

  it('writes an extractions row for every outcome of a call', async () => {
    for (const claude of [['invoice'], ['not-supported'], ['error-400'], ['error-429'], ['refusal'], ['no-tool-call']]) {
      const deps = fake({ claude })
      await processQueue(deps)
      expect(deps.records, claude[0]).toHaveLength(1)
    }
  })
})
