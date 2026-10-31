import { readdirSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { SAMPLES_DIR } from './samples.ts'

// Uploads the sample files in demo/samples/ to the local stack's demo bucket, each at its own name,
// which is its file_path (Lead ruling 2 on #41): the e2e setup runs it before the specs, and
// `npm run demo:upload` before `npm run dev`. Only ever the local stack, with its service role key;
// production's files are uploaded once by the operator (docs/go-live.md).

const LOCAL_API_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/

const CONTENT_TYPES: Record<string, string> = { pdf: 'application/pdf', png: 'image/png' }

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Put the values from \`npx supabase status\` in .env.local.`)
  return value
}

/** Uploads every sample, replacing what is there; returns the names uploaded. */
export async function uploadDemoSamples(): Promise<string[]> {
  const url = env('NEXT_PUBLIC_SUPABASE_URL')
  if (!LOCAL_API_URL.test(url)) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not the local stack; the demo files go to production by hand.')
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
  const names = readdirSync(SAMPLES_DIR).sort()
  for (const name of names) {
    const contentType = CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)]
    if (!contentType) throw new Error(`demo/samples/${name} is not a PDF or a PNG.`)
    const { error } = await admin.storage.from('demo').upload(name, readFileSync(new URL(name, SAMPLES_DIR)), { contentType, upsert: true })
    if (error) throw new Error(`demo/samples/${name} could not be uploaded: ${error.message}`)
  }
  return names
}
