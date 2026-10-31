import { describe, expect, it, vi } from 'vitest'
import { handleRequest } from './handler'

// process-queue's door (ARCHITECTURE.md section 6.1): pg_cron calls it through pg_net with the
// shared CRON_SECRET in a header; anything else is answered 401 and processes nothing.

const SECRET = 'cron-secret-for-tests'

const request = (headers: Record<string, string> = {}) => new Request('http://functions/process-queue', { method: 'POST', headers })

describe('handleRequest', () => {
  it('answers 401 without the CRON_SECRET header, or with a wrong one, and runs nothing', async () => {
    for (const headers of [{}, { 'x-cron-secret': 'wrong' }, { 'x-cron-secret': `${SECRET}x` }, { Authorization: `Bearer ${SECRET}` }]) {
      const run = vi.fn()
      const response = await handleRequest(request(headers), SECRET, run)
      expect(response.status).toBe(401)
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('runs one queue step with the right secret and answers with its outcome', async () => {
    const run = vi.fn(async () => ({ outcome: 'empty' as const }))
    const response = await handleRequest(request({ 'x-cron-secret': SECRET }), SECRET, run)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ outcome: 'empty' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('answers 500 when the step throws, without its details', async () => {
    const response = await handleRequest(request({ 'x-cron-secret': SECRET }), SECRET, async () => {
      throw new Error('database down: secret detail')
    })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret detail')
  })
})
