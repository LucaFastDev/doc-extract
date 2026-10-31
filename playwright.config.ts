import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// The specs sign test users in against the local stack (e2e/support/auth.ts), whose URL and keys
// are in .env.local, or in the environment in CI, which wins over the file.
if (existsSync('.env.local')) process.loadEnvFile('.env.local')

// One port per checkout, so a worktree, a QA pass and the main checkout never share a dev server
// (ai-hq docs/03-workers.md, "Tests"). E2E_PORT, when set, wins. Set here, before defineConfig,
// so Playwright's workers inherit the same value.
process.env.E2E_PORT ||= String(
  20000 + (parseInt(createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8), 16) % 10000),
)
const PORT = Number(process.env.E2E_PORT)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // next dev has no --strictPort; a server already on this port is this checkout's own.
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
