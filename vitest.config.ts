import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests. The access tests, which need the local stack, have their own config
// (vitest.access.config.ts); the Playwright specs are in e2e/.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // server-only throws on import outside a React Server Components build; tests run in Node.
      'server-only': fileURLToPath(new URL('./tests/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'shared/**/*.test.ts'],
    environment: 'node',
  },
})
