import { describe, expect, it } from 'vitest'
import { buildRequest, ClaudeError, classifyError, createClaudeClient, PROMPT_VERSION, readResponse, SYSTEM_PROMPT } from './claude'
import { fixtureApi, fixtureResponse } from './fake-claude'

// The Claude client (ARCHITECTURE.md section 9, Lead ruling 1 on #24): one Messages API call per
// document, the file as a base64 document or image block, every type's strict tool plus
// record_not_supported under tool_choice auto to detect the type, or only the chosen type's tool;
// exactly one tool call is a result, anything else is invalid output. No network: the SDK is
// replaced by recorded responses from ./fixtures.

const PDF = { bytes: new TextEncoder().encode('%PDF-1.7 fixture'), mimeType: 'application/pdf' }
const PNG = { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mimeType: 'image/png' }
const OPTIONS = { model: 'claude-sonnet-5-5', maxTokens: 8192 }

describe('buildRequest', () => {
  it('detects the type: every tool, strict, under tool_choice auto, temperature 0, max_tokens from app_config', () => {
    const request = buildRequest(PDF, null, OPTIONS)
    expect(request).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 8192,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tool_choice: { type: 'auto' },
    })
    expect(request.tools.map((t) => [t.name, t.strict])).toEqual([
      ['record_invoice', true],
      ['record_not_supported', true],
    ])
  })

  it('sends only the chosen type’s tool, still under tool_choice auto', () => {
    const request = buildRequest(PDF, 'invoice', OPTIONS)
    expect(request.tools.map((t) => t.name)).toEqual(['record_invoice'])
    expect(request.tool_choice).toEqual({ type: 'auto' })
  })

  it('tells Claude to call exactly one tool, read only what is printed and keep text as printed', () => {
    expect(SYSTEM_PROMPT).toMatch(/exactly one/i)
    expect(SYSTEM_PROMPT).toMatch(/never invent/i)
    expect(SYSTEM_PROMPT).toMatch(/YYYY-MM-DD/)
    expect(SYSTEM_PROMPT).toMatch(/do not translate/i)
    expect(PROMPT_VERSION).toMatch(/\S/)
  })

  it('sends a PDF as a base64 document block and an image as a base64 image block', () => {
    const [pdfBlock] = buildRequest(PDF, null, OPTIONS).messages[0].content
    expect(pdfBlock).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(PDF.bytes).toString('base64') },
    })
    const [imageBlock] = buildRequest(PNG, null, OPTIONS).messages[0].content
    expect(imageBlock).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG.bytes).toString('base64') },
    })
  })

  it('encodes a large file without overflowing the stack', () => {
    const big = { bytes: new Uint8Array(3 * 1024 * 1024).fill(65), mimeType: 'application/pdf' }
    const [block] = buildRequest(big, null, OPTIONS).messages[0].content as { source: { data: string } }[]
    expect(block.source.data).toBe(Buffer.from(big.bytes).toString('base64'))
  })
})

describe('readResponse', () => {
  it('reads an invoice tool call: the type, its input and the usage', () => {
    const result = readResponse(fixtureResponse('invoice'), null)
    expect(result.docType).toBe('invoice')
    expect(result.toolName).toBe('record_invoice')
    expect((result.input as { invoice_number: { value: string } }).invoice_number.value).toBe('INV-1042')
    expect(result.usage).toEqual({ input_tokens: 2400, output_tokens: 1100 })
  })

  it('reads record_not_supported as not_supported', () => {
    const result = readResponse(fixtureResponse('not-supported'), null)
    expect(result).toMatchObject({ docType: 'not_supported', toolName: 'record_not_supported', input: { reason: expect.any(String) } })
  })

  it('treats a response with no tool call, or more than one, as invalid output, keeping its usage', () => {
    for (const name of ['no-tool-call', 'two-tool-calls']) {
      const error = (() => {
        try {
          readResponse(fixtureResponse(name), null)
        } catch (e) {
          return e
        }
      })()
      expect(error, name).toBeInstanceOf(ClaudeError)
      expect((error as ClaudeError).kind, name).toBe('invalid_output')
      expect((error as ClaudeError).usage?.input_tokens, name).toBe(2400)
    }
  })

  it('treats a cut-off answer, or a tool that was not sent, as invalid output', () => {
    const cut = { ...fixtureResponse('invoice'), stop_reason: 'max_tokens' }
    expect(() => readResponse(cut, null)).toThrow(expect.objectContaining({ kind: 'invalid_output' }))
    // With the type chosen, record_not_supported is not sent.
    expect(() => readResponse(fixtureResponse('not-supported'), 'invoice')).toThrow(expect.objectContaining({ kind: 'invalid_output' }))
  })

  it('treats a refusal as fatal', () => {
    expect(() => readResponse(fixtureResponse('refusal'), null)).toThrow(
      expect.objectContaining({ kind: 'fatal', reason: 'Claude declined to read this document.' }),
    )
  })
})

describe('classifyError', () => {
  it('makes 429, 500, 529, a network error and a timeout retryable', () => {
    for (const status of [429, 500, 529, 503]) {
      expect(classifyError(Object.assign(new Error('x'), { status })).kind, String(status)).toBe('retryable')
    }
    expect(classifyError(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }))).toMatchObject({
      kind: 'retryable',
      reason: 'Claude could not be reached.',
    })
    expect(classifyError(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))).toMatchObject({
      kind: 'retryable',
      reason: 'Claude did not answer in time.',
    })
  })

  it('makes a 400 fatal with a reason the user can read', () => {
    expect(classifyError(Object.assign(new Error('400 The PDF specified could not be read.'), { status: 400 }))).toMatchObject({
      kind: 'fatal',
      status: 400,
      reason: 'Claude could not read this file. It may be damaged, password-protected or too large.',
    })
  })
})

describe('createClaudeClient', () => {
  it('calls the Messages API once with the built request and reads the answer', async () => {
    const api = fixtureApi('invoice')
    const client = createClaudeClient(api, OPTIONS)
    const result = await client.extract(PDF, null)
    expect(result.docType).toBe('invoice')
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]).toEqual(buildRequest(PDF, null, OPTIONS))
  })

  it('turns an API error into a ClaudeError of its kind', async () => {
    const cases = [
      ['error-400', 'fatal'],
      ['error-429', 'retryable'],
      ['error-500', 'retryable'],
      ['error-529', 'retryable'],
    ] as const
    for (const [name, kind] of cases) {
      const client = createClaudeClient(fixtureApi(name), OPTIONS)
      await expect(client.extract(PDF, null), name).rejects.toMatchObject({ kind })
    }
  })
})
