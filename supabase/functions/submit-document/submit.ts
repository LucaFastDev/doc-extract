import type { AcceptedMimeType } from '../../../shared/limits.ts'
import {
  allowanceRefusal,
  countPages,
  magicBytesRefusal,
  pageLimitRefusal,
  sha256Hex,
  type PageAllowance,
} from './checks.ts'

// submit-document's steps (ARCHITECTURE.md sections 2 and 6.1), with the database and Storage
// behind SubmitDeps so the unit tests run them without either. index.ts supplies the real ones.

export interface SubmittedDocument {
  id: string
  workspace_id: string
  status: string
  file_name: string
  mime_type: string
  storage_path: string
}

export interface SubmitDeps {
  /** The caller, from their JWT; null when it is missing or invalid. */
  userId(): Promise<string | null>
  /** The document read as the caller, so RLS returns it only to a member of its workspace. */
  loadDocument(id: string): Promise<SubmittedDocument | null>
  /** is_member, as the caller. */
  isMember(workspaceId: string): Promise<boolean>
  /** The uploaded object, or null when it is not there. */
  download(path: string): Promise<Uint8Array | null>
  /** Stores the page count and SHA-256 on the row, which reserve_pages reads. */
  recordFile(id: string, file: { page_count: number; sha256: string }): Promise<void>
  /** reserve_pages, with the service role. */
  reservePages(id: string): Promise<boolean>
  /** get_page_allowance, as the caller. */
  allowance(workspaceId: string): Promise<PageAllowance>
  /** Sets status rejected with the reason. */
  reject(id: string, reason: string, file?: { page_count?: number | null; sha256?: string | null }): Promise<void>
  /** Sets status queued. The extraction queue itself is milestone 5. */
  queue(id: string): Promise<void>
}

export interface SubmitResult {
  status: number
  body: { error: string } | { document: { id: string; status: 'queued'; page_count: number } }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const refused = (error: string): SubmitResult => ({ status: 409, body: { error } })

/**
 * Checks the caller and the document, then the file: magic bytes, page count, the 10-page limit,
 * and the allowances through reserve_pages. Every refusal happens before reserve_pages, or is
 * reserve_pages' own, so no refusal leaves pages counted.
 */
export async function submitDocument(body: unknown, deps: SubmitDeps): Promise<SubmitResult> {
  const documentId = (body as { document_id?: unknown } | null)?.document_id
  if (typeof documentId !== 'string' || !UUID.test(documentId)) {
    return { status: 400, body: { error: 'Send the document_id of the document to submit.' } }
  }
  if (!(await deps.userId())) return { status: 401, body: { error: 'Sign in to upload documents.' } }

  const doc = await deps.loadDocument(documentId)
  if (!doc) return { status: 404, body: { error: 'No such document.' } }
  if (!(await deps.isMember(doc.workspace_id))) {
    return { status: 403, body: { error: 'You are not a member of this workspace.' } }
  }
  if (doc.status !== 'uploading') return refused(`${doc.file_name} has already been submitted.`)

  const reject = async (reason: string, file?: { page_count?: number | null; sha256?: string | null }) => {
    await deps.reject(doc.id, reason, file)
    return refused(reason)
  }

  const bytes = await deps.download(doc.storage_path)
  if (!bytes) return reject(`${doc.file_name} did not finish uploading. Upload it again.`)

  // The content must be the accepted type the file was created as.
  const typeRefusal = magicBytesRefusal(doc.file_name, bytes, doc.mime_type)
  if (typeRefusal) return reject(typeRefusal)

  const pageCount = await countPages(bytes, doc.mime_type as AcceptedMimeType)
  if (pageCount === null) return reject(`${doc.file_name} could not be read as a PDF.`)
  const sha256 = await sha256Hex(bytes)
  const tooLong = pageLimitRefusal(doc.file_name, pageCount)
  if (tooLong) return reject(tooLong, { page_count: pageCount, sha256 })

  await deps.recordFile(doc.id, { page_count: pageCount, sha256 })
  if (!(await deps.reservePages(doc.id))) {
    return reject(allowanceRefusal(doc.file_name, pageCount, await deps.allowance(doc.workspace_id)))
  }
  await deps.queue(doc.id)
  return { status: 202, body: { document: { id: doc.id, status: 'queued', page_count: pageCount } } }
}
