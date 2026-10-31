import { existsSync } from 'node:fs'
import { uploadDemoSamples } from './upload.ts'

// `npm run demo:upload`: puts the sample files in the local stack's demo bucket, for `npm run dev`.
// The URL and the service role key come from .env.local, or the environment, which wins.
if (existsSync('.env.local')) process.loadEnvFile('.env.local')
for (const name of await uploadDemoSamples()) console.log(`Uploaded demo/samples/${name} to the local demo bucket`)
