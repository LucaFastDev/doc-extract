import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Not a real project: the module only checks that the variables are set.
const URL = 'http://supabase.invalid'
const ANON_KEY = 'test-anon-key'

// Outside a request, next/headers has no cookie store; this stands in for one.
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

describe('src/lib/supabase/server.ts', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws at load when NEXT_PUBLIC_SUPABASE_URL is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY)
    await expect(import('./server')).rejects.toThrow('NEXT_PUBLIC_SUPABASE_URL is not set')
  })

  it('throws at load when NEXT_PUBLIC_SUPABASE_ANON_KEY is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
    await expect(import('./server')).rejects.toThrow('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')
  })

  it('builds a client when both are set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY)
    const { createClient } = await import('./server')
    expect((await createClient()).auth).toBeDefined()
  })

  it('throws when the service-role client is asked for while SUPABASE_SERVICE_ROLE_KEY is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const { createServiceRoleClient } = await import('./server')
    expect(() => createServiceRoleClient()).toThrow('SUPABASE_SERVICE_ROLE_KEY is not set')
  })

  it('builds the service-role client when its key is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
    const { createServiceRoleClient } = await import('./server')
    expect(createServiceRoleClient().storage).toBeDefined()
  })
})
