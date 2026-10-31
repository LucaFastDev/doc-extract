import type { SupabaseClient } from '@supabase/supabase-js'
import type { CheckResult } from '@shared/doctypes/fields'
import type { ReviewRow } from './review'

// What the review screen shows of one document (PRD F5), read as the signed-in user through RLS:
// by the page's server component first, then by the screen itself after each change.

export interface ReviewDocument {
  id: string
  workspace_id: string
  file_name: string
  mime_type: string
  storage_path: string | null
  status: string
  status_reason: string | null
  doc_type: string | null
  page_count: number | null
  created_at: string
  uploaded_by: string | null
  approved_by: string | null
  approved_at: string | null
  file_deleted_at: string | null
}

export interface ReviewEvent {
  id: string
  kind: 'uploaded' | 'extracted' | 'approved' | 'reopened' | 'type_changed' | 'retried'
  actor: string | null
  created_at: string
}

export interface ReviewData {
  document: ReviewDocument
  fields: ReviewRow[]
  checks: CheckResult[]
  /** The check ids that have a tick. */
  ticks: string[]
  /** Newest first, the upload last (US-5.1 AC-7). */
  events: ReviewEvent[]
  /** Display names of the uploader, the approver and every actor, by profile id. */
  people: Record<string, string>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** null when the document does not exist or the user may not read it. */
export async function loadReview(supabase: SupabaseClient, id: string): Promise<ReviewData | null> {
  if (!UUID.test(id)) return null
  const { data: document, error } = await supabase
    .from('documents')
    .select(
      'id, workspace_id, file_name, mime_type, storage_path, status, status_reason, doc_type, page_count, created_at, uploaded_by, approved_by, approved_at, file_deleted_at',
    )
    .eq('id', id)
    .maybeSingle<ReviewDocument>()
  if (error) throw error
  if (!document) return null

  const [fields, checks, ticks, events] = await Promise.all([
    supabase
      .from('extraction_fields')
      .select('path, kind, extracted_value, corrected_value, confidence, flags')
      .eq('document_id', id)
      .returns<ReviewRow[]>(),
    supabase.from('check_results').select('check_id, status, field_paths, message').eq('document_id', id).order('check_id').returns<CheckResult[]>(),
    supabase.from('check_ticks').select('check_id').eq('document_id', id).returns<{ check_id: string }[]>(),
    supabase
      .from('document_events')
      .select('id, kind, actor, created_at')
      .eq('document_id', id)
      .order('created_at', { ascending: false })
      .returns<ReviewEvent[]>(),
  ])
  for (const r of [fields, checks, ticks, events]) if (r.error) throw r.error

  const history: ReviewEvent[] = [
    ...events.data!,
    { id: `uploaded-${document.id}`, kind: 'uploaded', actor: document.uploaded_by, created_at: document.created_at },
  ]
  const ids = [...new Set([document.approved_by, ...history.map((e) => e.actor)].filter((x): x is string => x !== null))]
  const people: Record<string, string> = {}
  if (ids.length > 0) {
    const profiles = await supabase.from('profiles').select('id, display_name, email').in('id', ids)
    if (profiles.error) throw profiles.error
    for (const p of profiles.data as { id: string; display_name: string | null; email: string }[]) {
      people[p.id] = p.display_name?.trim() || p.email
    }
  }

  return {
    document,
    fields: fields.data!.map((r) => ({ ...r, confidence: r.confidence === null ? null : Number(r.confidence) })),
    checks: checks.data!,
    ticks: ticks.data!.map((t) => t.check_id),
    events: history,
    people,
  }
}
