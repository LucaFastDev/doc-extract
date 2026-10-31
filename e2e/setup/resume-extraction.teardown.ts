import { test as teardown } from '@playwright/test'
import { sql } from '../support/auth'

// After every project that depends on "pause extraction", whether or not they passed: extraction
// is on again, as the seed sets it, so the local stack keeps processing uploads.
teardown('resume extraction', async () => {
  await sql('update public.app_config set extract_concurrency = 1')
})
