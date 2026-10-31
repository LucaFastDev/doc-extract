import { readFileSync } from 'node:fs'
import type { ExtractRequest, MessagesApi } from './claude.ts'

// For the unit tests only (ARCHITECTURE.md section 9, "How tests mock Claude"): a Messages API that
// answers with the recorded responses in ./fixtures, so no test reaches the network. The e2e mock
// server (e2e/mock-claude/) answers with the same files.

export interface Fixture {
  status: number
  body: unknown
}

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture
}

export function fixtureResponse(name: string): Record<string, unknown> {
  return fixture(name).body as Record<string, unknown>
}

/**
 * Answers each call with the next fixture, repeating the last. A non-200 fixture is thrown as the
 * SDK throws an API error; 'network-error' and 'timeout' as its connection errors.
 */
export function fixtureApi(...names: string[]): MessagesApi & { requests: ExtractRequest[] } {
  const requests: ExtractRequest[] = []
  return {
    requests,
    async create(params) {
      requests.push(params)
      const name = names[Math.min(requests.length - 1, names.length - 1)]
      if (name === 'network-error') throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })
      if (name === 'timeout') throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })
      const f = fixture(name)
      if (f.status !== 200) {
        const message = (f.body as { error?: { message?: string } }).error?.message ?? 'error'
        throw Object.assign(new Error(`${f.status} ${message}`), { status: f.status, error: f.body })
      }
      return f.body
    },
  }
}
