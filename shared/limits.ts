// The limits on uploads (PRD section 5, OQ-4, OQ-42), shared by the upload control and the
// submit-document Edge Function. Plain TypeScript with no imports, so Next.js and Deno both read it
// (ARCHITECTURE.md section 3). create_document and the documents bucket hold the same values.

export const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number]

/** For messages: "PDF, JPEG, PNG and WebP". */
export const ACCEPTED_TYPES_LABEL = 'PDF, JPEG, PNG and WebP'

export const MAX_FILE_BYTES = 10 * 1024 * 1024

export const MAX_PAGES = 10

export const MAX_FILES = 10

export function isAcceptedMimeType(type: string): type is AcceptedMimeType {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(type)
}

/** "1 page", "3 pages". */
export function pages(n: number): string {
  return `${n} ${n === 1 ? 'page' : 'pages'}`
}
