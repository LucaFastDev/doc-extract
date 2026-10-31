import { createHash } from 'node:crypto'

// The mock Claude server's port: one per checkout, like E2E_PORT (playwright.config.ts), so a
// worktree, a QA pass and the main checkout each run their own. MOCK_CLAUDE_PORT, when set, wins.
// The Edge Functions reach it through ANTHROPIC_BASE_URL in supabase/functions/.env, which
// functions-env.ts writes from the same number.

export function mockClaudePort(cwd = process.cwd()): number {
  if (process.env.MOCK_CLAUDE_PORT) return Number(process.env.MOCK_CLAUDE_PORT)
  return 30000 + (parseInt(createHash('sha256').update(cwd).digest('hex').slice(0, 8), 16) % 10000)
}
