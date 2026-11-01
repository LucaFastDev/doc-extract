import { describe, expect, it } from 'vitest'
import { buildRequest } from '../supabase/functions/_shared/claude'
import { DEFAULT_MODEL, fixedInputTokens, SETTINGS } from './run'

// Issue #71: app_config.base_input_tokens is the fixed part of the spend estimate
// (ARCHITECTURE.md section 7), so a request whose fixed part outgrows it can cost more than was
// reserved. This is the dry run's own sum, with the file left out. A failure here means raising
// the setting in a new migration, not this number on its own.

/** app_config.base_input_tokens, as tests/access/extraction-tables.test.ts asserts it. */
const BASE_INPUT_TOKENS = 20000

const OPTIONS = { model: DEFAULT_MODEL, maxTokens: SETTINGS.max_tokens }

describe('the fixed part of a request', () => {
  // No document type: every type's tool and record_not_supported, the largest request there is.
  const request = (bytes: Uint8Array) => buildRequest({ bytes, mimeType: 'application/pdf' }, null, OPTIONS)

  it('fits inside app_config.base_input_tokens', () => {
    const tokens = fixedInputTokens(request(new Uint8Array()))
    console.info('fixed part of a request, in tokens:', tokens)
    expect(tokens).toBeLessThanOrEqual(BASE_INPUT_TOKENS)
    // Far above the old setting of 4000, so the sum really counted the tools.
    expect(tokens).toBeGreaterThan(4000)
  })

  it('leaves the file itself out of the count', () => {
    expect(fixedInputTokens(request(new Uint8Array(100_000)))).toBe(fixedInputTokens(request(new Uint8Array())))
  })
})
