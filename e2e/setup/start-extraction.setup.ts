import { test as setup } from '@playwright/test'
import { sql } from '../support/auth'

// Before the extraction specs (playwright.config.ts): the upload specs' messages are dropped, so
// the extraction specs' documents are the only ones in the queue, and the cron job dispatches
// process-queue again, as the seed sets it (app_config.extract_concurrency = 1).
setup('start extraction', async () => {
  await sql("select pgmq.purge_queue('extract')")
  await sql('update public.app_config set extract_concurrency = 1')
})
