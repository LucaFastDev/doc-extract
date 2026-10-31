import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocType } from '@shared/doctypes/index'
import { exportDocument, type ExportInput } from './model'

// What the export page reads, in the browser, as the signed-in user through RLS (ARCHITECTURE.md
// section 11, OQ-13): the workspace's approved documents, then the fields of the ones chosen. No
// route handler or Edge Function is involved.

export interface ApprovedDocument {
  id: string
  file_name: string
  doc_type: string | null
  approved_at: string
}

/** PostgREST returns at most max_rows (1000) rows per request, so longer reads go page by page. */
const PAGE = 1000
/** Document ids per extraction_fields request, which keeps the URL short. */
const IDS_PER_REQUEST = 100

async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...data!)
    if (data!.length < PAGE) return rows
  }
}

const APPROVED_COLUMNS = 'id, file_name, doc_type, approved_at'

/** The workspace's approved documents, newest approval first. */
export function loadApproved(supabase: SupabaseClient, workspaceId: string): Promise<ApprovedDocument[]> {
  return readAll((from, to) =>
    supabase
      .from('documents')
      .select(APPROVED_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('status', 'approved')
      .order('approved_at', { ascending: false })
      .order('id')
      .range(from, to)
      .returns<ApprovedDocument[]>(),
  )
}

/**
 * The export's data for the chosen documents, in the order given. Each is read again first, so one
 * reopened, changed to another type or deleted since the list was loaded is left out (US-6.1 AC-1);
 * `left` counts those.
 */
export async function loadExportInput(
  supabase: SupabaseClient,
  workspaceId: string,
  docType: DocType,
  ids: string[],
): Promise<{ input: ExportInput; left: number }> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) chunks.push(ids.slice(i, i + IDS_PER_REQUEST))

  const approved = new Map<string, ApprovedDocument>()
  const fields = new Map<string, { path: string; extracted_value: string | null; corrected_value: string | null }[]>()
  for (const chunk of chunks) {
    const docs = await readAll((from, to) =>
      supabase
        .from('documents')
        .select(APPROVED_COLUMNS)
        .eq('workspace_id', workspaceId)
        .eq('status', 'approved')
        .eq('doc_type', docType)
        .in('id', chunk)
        .order('id')
        .range(from, to)
        .returns<ApprovedDocument[]>(),
    )
    for (const d of docs) approved.set(d.id, d)
    const rows = await readAll((from, to) =>
      supabase
        .from('extraction_fields')
        .select('document_id, path, extracted_value, corrected_value')
        .in('document_id', chunk)
        .order('document_id')
        .order('path')
        .range(from, to)
        .returns<{ document_id: string; path: string; extracted_value: string | null; corrected_value: string | null }[]>(),
    )
    for (const r of rows) {
      if (!fields.has(r.document_id)) fields.set(r.document_id, [])
      fields.get(r.document_id)!.push(r)
    }
  }

  const kept = ids.filter((id) => approved.has(id))
  return {
    input: { docType, documents: kept.map((id) => exportDocument(docType, approved.get(id)!, fields.get(id) ?? [])) },
    left: ids.length - kept.length,
  }
}
