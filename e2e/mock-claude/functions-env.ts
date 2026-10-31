import { writeFileSync } from 'node:fs'
import { mockClaudePort } from './port.ts'

// Writes supabase/functions/.env (gitignored) for the local stack and CI: a dummy key, the mock
// Claude server as ANTHROPIC_BASE_URL, and the local CRON_SECRET that supabase/seed.sql puts in
// Vault. `npx supabase start` reads it, so run this first: `npm run functions:env`. No real key
// and no production URL is ever written (ARCHITECTURE.md section 9).

const path = new URL('../../supabase/functions/.env', import.meta.url)

writeFileSync(
  path,
  [
    '# Written by `npm run functions:env` for the local stack. Never put a production value here.',
    'ANTHROPIC_API_KEY=mock-key-not-a-real-key',
    `ANTHROPIC_BASE_URL=http://host.docker.internal:${mockClaudePort()}`,
    'CRON_SECRET=local-cron-secret-not-for-production',
    '',
  ].join('\n'),
)
console.log(`supabase/functions/.env points ANTHROPIC_BASE_URL at the mock server on port ${mockClaudePort()}`)
