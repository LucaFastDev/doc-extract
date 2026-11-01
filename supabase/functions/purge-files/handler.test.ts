import { describe, expect, it, vi } from 'vitest'
import { handleRequest } from './handler'

// purge-files' door (ARCHITECTURE.md sections 6.1 and 8, issue #48 criterion 1): pg_cron calls it
// through pg_net with the shared CRON_SECRET in a header; anything else is answered 401 and
// purges nothing.

const SECRET = 'cron-secret-for-tests'

const request = (headers: Record<string, string> = {}) => new Request('http://functions/purge-files', { method: 'POST', headers })

describe('handleRequest', () => {
  it('answers 401 without the CRON_SECRET header, or with a wrong one, and runs nothing', async () => {
    for (const headers of [{}, { 'x-cron-secret': 'wrong' }, { 'x-cron-secret': `${SECRET}x` }, { Authorization: `Bearer ${SECRET}` }]) {
      const run = vi.fn()
      const response = await handleRequest(request(headers), SECRET, run)
      expect(response.status).toBe(401)
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('runs one purge with the right secret and answers with its counts', async () => {
    const counts = { files_removed: 2, files_failed: 1, stale_uploads_removed: 1, reservations_released: 0 }
    const run = vi.fn(async () => counts)
    const response = await handleRequest(request({ 'x-cron-secret': SECRET }), SECRET, run)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(counts)
    expect(run).toHaveBeenCalledOnce()
  })

  it('answers 500 when the purge throws, without its details', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await handleRequest(request({ 'x-cron-secret': SECRET }), SECRET, async () => {
      throw new Error('database down: secret detail')
    })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret detail')
    error.mockRestore()
  })
})
