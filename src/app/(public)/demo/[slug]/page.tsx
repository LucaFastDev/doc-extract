import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { loadDemoSample } from '@/lib/demo/sample'
import { createAnonClient } from '@/lib/supabase/server'
import { DemoReview } from './demo-review'

export const metadata: Metadata = { title: 'Demo · doc-extract' }

// One sample on the review screen in demo mode (PRD F13 AC-3 to AC-5), read as anon whoever is
// signed in: an unknown or unpublished slug gets the not-found page and no data.
export default async function DemoSamplePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const sample = await loadDemoSample(createAnonClient(), slug)
  if (!sample) notFound()
  return <DemoReview key={sample.slug} sample={sample} />
}
