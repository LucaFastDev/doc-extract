import { test as setup } from '@playwright/test'
import { sql } from '../support/auth'

// Before the upload specs (playwright.config.ts): the cron job dispatches no process-queue
// requests, so documents stay as uploaded while those specs check them. Messages left from an
// earlier run are dropped, so none is processed when extraction resumes.
setup('pause extraction', async () => {
  await sql('update public.app_config set extract_concurrency = 0')
  await sql("select pgmq.purge_queue('extract')")
})
