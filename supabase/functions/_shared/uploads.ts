// How long an upload may stay in status uploading (ARCHITECTURE.md sections 6.1 and 8). purge-files
// removes one once it is STALE_UPLOAD_MS old; submit-document stops accepting one SUBMIT_WINDOW_MS
// after it was created, ten minutes sooner. Those ten minutes are longer than any Edge Function run
// can last, so a submit that started inside the window has ended before the purge can take its
// document, and the two never work on the same document at once.

/** An upload that has not reached submit-document in this long never will; the purge removes it. */
export const STALE_UPLOAD_MS = 60 * 60 * 1000

/** submit-document refuses an upload this old or older, so the purge cannot take one it is running on. */
export const SUBMIT_WINDOW_MS = STALE_UPLOAD_MS - 10 * 60 * 1000
