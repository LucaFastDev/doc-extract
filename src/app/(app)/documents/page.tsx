import type { Metadata } from 'next'
import { LISTED_STATUSES, type PageAllowance } from '@/lib/documents/upload'
import { getWorkspaceContext } from '@/lib/workspace/server'
import { DocumentsView, type DocumentItem } from './documents-view'

export const metadata: Metadata = { title: 'Documents · doc-extract' }

// The document list, where sign-in lands by default (OQ-34), with the upload control (PRD F1,
// F10). Read as the user, through RLS; the list then follows status changes through Realtime.
export default async function DocumentsPage() {
  const { supabase, current } = await getWorkspaceContext()
  if (!current) return null

  const { data: documents, error } = await supabase
    .from('documents')
    .select('id, file_name, doc_type, status, page_count, created_at')
    .eq('workspace_id', current.id)
    .in('status', LISTED_STATUSES)
    .order('created_at', { ascending: false })
    .returns<DocumentItem[]>()
  if (error) throw error

  const { data: allowance, error: allowanceError } = await supabase
    .rpc('get_page_allowance', { ws: current.id })
    .single<PageAllowance>()
  if (allowanceError) throw allowanceError

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
      <DocumentsView
        key={current.id}
        workspace={{ id: current.id, name: current.name }}
        initialDocuments={documents}
        initialAllowance={allowance}
      />
    </main>
  )
}
