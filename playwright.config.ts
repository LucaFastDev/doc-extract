import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'
import { mockClaudePort } from './e2e/mock-claude/port'

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

// The mock Claude server (ARCHITECTURE.md section 9): the local Edge Functions reach it through
// ANTHROPIC_BASE_URL in supabase/functions/.env, written for this same port by
// `npm run functions:env` before `npx supabase start`.
process.env.MOCK_CLAUDE_PORT ||= String(mockClaudePort())
const MOCK_PORT = Number(process.env.MOCK_CLAUDE_PORT)

const chrome = { ...devices['Desktop Chrome'] }

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
  // The pg_cron job extracts every queued document within seconds. The upload specs check
  // documents as uploaded (Queued, their pages held), so they run with extraction paused
  // (app_config.extract_concurrency = 0); the extraction specs run after them with it on.
  projects: [
    { name: 'pause extraction', testMatch: /pause-extraction\.setup\.ts/, teardown: 'resume extraction' },
    { name: 'resume extraction', testMatch: /resume-extraction\.teardown\.ts/ },
    // The demo's sample files, uploaded to the local demo bucket (demo/upload.ts).
    { name: 'demo files', testMatch: /demo-files\.setup\.ts/ },
    { name: 'chromium', use: chrome, testIgnore: /extraction\.spec\.ts/, dependencies: ['pause extraction', 'demo files'] },
    { name: 'start extraction', testMatch: /start-extraction\.setup\.ts/, dependencies: ['chromium'] },
    { name: 'extraction', use: chrome, testMatch: /extraction\.spec\.ts/, dependencies: ['start extraction'] },
  ],
  webServer: [
    {
      // next dev has no --strictPort; a server already on this port is this checkout's own.
      command: `npm run dev -- --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      // Invitation links are built from SITE_URL (src/lib/site.ts): here, the test server itself.
      env: { SITE_URL: BASE_URL },
    },
    {
      command: 'node e2e/mock-claude/server.ts',
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { MOCK_CLAUDE_PORT: String(MOCK_PORT) },
    },
  ],
})
