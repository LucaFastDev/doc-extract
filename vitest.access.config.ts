import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Access tests (ARCHITECTURE.md section 4.4) run against the local stack after
// `npx supabase db reset`. They read its URL, keys and SUPABASE_DB_URL from .env.local, or from
// the environment in CI, which wins over the file.
if (existsSync('.env.local')) process.loadEnvFile('.env.local')

export default defineConfig({
  test: {
    include: ['tests/access/**/*.test.ts'],
    environment: 'node',
    // One stack, shared: files run one at a time so their rows do not interleave.
    fileParallelism: false,
  },
})
