import type { Metadata } from 'next'
import { getWorkspaceContext } from '@/lib/workspace/server'
import { ExportView } from './export-view'

export const metadata: Metadata = { title: 'Export · doc-extract' }

// Export of approved documents (PRD F6, US-6.1, OQ-13). The page only names the current workspace;
// the documents and their fields are read in the browser, through RLS, and the file is built there
// (ARCHITECTURE.md section 11).
export default async function ExportPage() {
  const { current } = await getWorkspaceContext()
  if (!current) return null

  return (
    <main className="flex flex-col gap-6">
      <ExportView key={current.id} workspace={{ id: current.id, name: current.name }} />
    </main>
  )
}
