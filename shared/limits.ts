// The limits on uploads (PRD section 5, OQ-4, OQ-42), shared by the upload control and the
// submit-document Edge Function. Plain TypeScript with no imports, so Next.js and Deno both read it
// (ARCHITECTURE.md section 3). create_document holds the same values; the documents bucket holds
// the 10 MB file limit only.

export const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number]

/** For messages: "PDF, JPEG, PNG and WebP". */
export const ACCEPTED_TYPES_LABEL = 'PDF, JPEG, PNG and WebP'

export const MAX_FILE_BYTES = 10 * 1024 * 1024

// The API takes an image of at most 10 MB base64-encoded (ARCHITECTURE.md, "Input"). 7,500,000 bytes
// encode to exactly 10,000,000, within it whether MB means 10^6 bytes or MiB (Lead ruling on #28).
export const MAX_IMAGE_BYTES = 7_500_000

/** For messages: "7.5 MB". */
export const MAX_IMAGE_LABEL = '7.5 MB'

export const IMAGE_MIME_TYPES: readonly AcceptedMimeType[] = ['image/jpeg', 'image/png', 'image/webp']

export function isImageMimeType(type: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(type)
}

export const MAX_PAGES = 10

export const MAX_FILES = 10

export function isAcceptedMimeType(type: string): type is AcceptedMimeType {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(type)
}

/** "1 page", "3 pages". */
export function pages(n: number): string {
  return `${n} ${n === 1 ? 'page' : 'pages'}`
}
