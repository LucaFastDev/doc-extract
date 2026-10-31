import type { Metadata } from 'next'
import { getWorkspaceContext } from '@/lib/workspace/server'

export const metadata: Metadata = { title: 'Documents · doc-extract' }

// The document list, where sign-in lands by default (OQ-34). A placeholder until upload and the
// list itself arrive in milestone 4.
export default async function DocumentsPage() {
  const { current } = await getWorkspaceContext()

  return (
    <main className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
      <p className="text-muted-foreground">
        No documents in <span className="font-medium text-foreground">{current?.name}</span> yet.
      </p>
    </main>
  )
}
