import { PDFDocument } from 'pdf-lib'
import { ACCEPTED_TYPES_LABEL, MAX_PAGES, pages, type AcceptedMimeType } from '../../../shared/limits.ts'

// The checks submit-document makes on an uploaded file (ARCHITECTURE.md section 6.1), as pure
// functions so the unit tests import them without the Deno runtime.

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b)
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** The accepted type the file's magic bytes say it is, or null when it is none of them. */
export function sniffType(bytes: Uint8Array): AcceptedMimeType | null {
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

/** A refusal when the content is not the type the file was uploaded as; null when it is. */
export function magicBytesRefusal(fileName: string, bytes: Uint8Array, declared: string): string | null {
  if (sniffType(bytes) === declared) return null
  return `${fileName} is not a PDF, JPEG, PNG or WebP file, or its content does not match its type. Accepted types: ${ACCEPTED_TYPES_LABEL}.`
}

/** A PDF's page count, or 1 for an image (OQ-2); null for a PDF that cannot be read. */
export async function countPages(bytes: Uint8Array, type: AcceptedMimeType): Promise<number | null> {
  if (type !== 'application/pdf') return 1
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    const count = doc.getPageCount()
    return count > 0 ? count : null
  } catch {
    return null
  }
}

/** A refusal for a document over 10 pages (OQ-4), naming the limit. */
export function pageLimitRefusal(fileName: string, pageCount: number): string | null {
  if (pageCount <= MAX_PAGES) return null
  return `${fileName} has ${pages(pageCount)}. A document can have at most ${pages(MAX_PAGES)}.`
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What get_page_allowance returns. */
export interface PageAllowance {
  workspace_used: number
  workspace_limit: number
  account_used: number
  account_cap: number
}

/** The pages left under the lower of the workspace's month and the account's lifetime cap. */
export function pagesRemaining(a: PageAllowance): number {
  return Math.max(0, Math.min(a.workspace_limit - a.workspace_used, a.account_cap - a.account_used))
}

/** The refusal for an upload over the allowances (PRD US-1.1 AC-6): how many pages remain. */
export function allowanceRefusal(fileName: string, pageCount: number, a: PageAllowance): string {
  const left = pagesRemaining(a)
  return `${fileName} has ${pages(pageCount)}, but only ${pages(left)} ${left === 1 ? 'remains' : 'remain'} of your page allowance (this workspace’s monthly allowance and your account’s ${a.account_cap}-page limit).`
}
