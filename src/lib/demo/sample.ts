import type { SupabaseClient } from '@supabase/supabase-js'
import type { CheckResult, FieldKind } from '@shared/doctypes/fields'
import type { DocType } from '@shared/doctypes/index'
import type { ReviewData } from '@/lib/documents/load-review'
import type { ReviewRow } from '@/lib/documents/review'
import { exportDocument, type ExportInput } from '@/lib/export/model'

// The public demo (PRD F13, section 6; ARCHITECTURE.md section 10): the samples in demo_documents,
// read as anon through RLS, which shows published rows only; and each sample as the review screen
// and the export take it. Nothing here writes: a visitor's edits live in the browser (OQ-25).

/** One field or cell of a stored result, as extraction_fields stores it. */
export interface DemoField {
  path: string
  kind: FieldKind
  extracted_value: string | null
  confidence: number
  flags: string[]
}

/** A sample's stored extraction, as process-queue would store it (demo_documents.result). */
export interface DemoResult {
  /** The detected type. */
  doc_type: DocType
  /** The amount tolerance its checks ran with, which the browser re-runs them with (OQ-7). */
  amount_tolerance: string
  fields: DemoField[]
  checks: CheckResult[]
}

/** A sample as /demo lists it. */
export interface DemoListing {
  slug: string
  doc_type: DocType
  title: string
  summary: string
  page_count: number
}

export interface DemoSample extends DemoListing {
  id: string
  /** The object in the demo bucket, `{slug}.{ext}`, and the file name the demo shows and exports. */
  file_path: string
  result: DemoResult
}

const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** The file's type from its extension, as the demo bucket's objects are named. */
export function demoMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/** The published samples, in sort_order. */
export async function listDemoSamples(supabase: SupabaseClient): Promise<DemoListing[]> {
  const { data, error } = await supabase
    .from('demo_documents')
    .select('slug, doc_type, title, summary, page_count')
    .order('sort_order')
    .returns<DemoListing[]>()
  if (error) throw error
  return data
}

/** A published sample; null for an unknown or unpublished slug. */
export async function loadDemoSample(supabase: SupabaseClient, slug: string): Promise<DemoSample | null> {
  const { data, error } = await supabase
    .from('demo_documents')
    .select('id, slug, doc_type, title, summary, page_count, file_path, result')
    .eq('slug', slug)
    .maybeSingle<DemoSample>()
  if (error) throw error
  return data
}

/**
 * The sample as the review screen takes a document: needing review, nothing corrected or ticked,
 * no history. It belongs to no workspace and was uploaded by nobody.
 */
export function demoReviewData(sample: DemoSample): ReviewData {
  return {
    document: {
      id: sample.id,
      workspace_id: '',
      file_name: sample.file_path,
      mime_type: demoMimeType(sample.file_path),
      storage_path: sample.file_path,
      status: 'needs_review',
      status_reason: null,
      doc_type: sample.result.doc_type,
      page_count: sample.page_count,
      created_at: '',
      uploaded_by: null,
      approved_by: null,
      approved_at: null,
      file_deleted_at: null,
    },
    fields: sample.result.fields.map((f) => ({ ...f, corrected_value: null })),
    checks: sample.result.checks,
    ticks: [],
    events: [],
    people: {},
  }
}

/**
 * The export of the sample as currently edited (F13 AC-5; Lead ruling 4 on #41): the same tables
 * as milestone 8's, its document_id the sample's id, its file_name the sample's file and its
 * approved_at empty, since a sample is never approved.
 */
export function demoExportInput(sample: Pick<DemoSample, 'id' | 'file_path' | 'result'>, rows: ReviewRow[]): ExportInput {
  const docType = sample.result.doc_type
  return {
    docType,
    documents: [exportDocument(docType, { id: sample.id, file_name: sample.file_path, approved_at: null }, rows)],
  }
}
