import { test as setup } from '@playwright/test'
import { uploadDemoSamples } from '../../demo/upload'

// Before the specs (playwright.config.ts): the demo's sample files in the local demo bucket, at the
// file_path names the demo_documents migration gives them (Lead ruling 2 on #41).
setup('upload the demo files', async () => {
  await uploadDemoSamples()
})
