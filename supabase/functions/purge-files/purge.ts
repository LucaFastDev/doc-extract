// purge-files' run (ARCHITECTURE.md section 8, PRD US-14.1, OQ-14, OQ-39, Lead rulings 3 and 5 on
// #48), with the database and Storage passed in, so the order of the steps and the counts are
// tested without either. It reads only documents rows and removes only from the documents bucket:
// the demo bucket and demo_documents are never read (ruling 5).

/** Documents per select and objects per Storage call. */
export const BATCH_SIZE = 100

const DAY_MS = 24 * 60 * 60 * 1000
/** A file is removed once its document is this old, measured from upload (US-14.1 AC-1). */
const FILE_AGE_MS = 7 * DAY_MS
/** An upload that has not reached submit-document in this long never will (section 8 step 4). */
const STALE_UPLOAD_MS = 60 * 60 * 1000

export interface ExpiredDocument {
  id: string
  storage_path: string | null
}

export interface StaleUpload {
  id: string
  storage_path: string | null
  pages_reserved: boolean | null
  file_deleted_at: string | null
}

export interface PurgeDeps {
  now(): Date
  /** Up to `limit` documents created before `before` whose file is not deleted, by id, after `afterId`. */
  selectExpired(before: Date, afterId: string | null, limit: number): Promise<ExpiredDocument[]>
  /** Removes the objects from the documents bucket; true when the Storage API reported no error. */
  removeObjects(paths: string[]): Promise<boolean>
  /** Sets file_deleted_at on the documents whose file_deleted_at is still null. */
  markFileDeleted(ids: string[], at: Date): Promise<void>
  /** Up to `limit` documents in status uploading created before `before`, by id, after `afterId`. */
  selectStaleUploads(before: Date, afterId: string | null, limit: number): Promise<StaleUpload[]>
  /** release_pages: gives the pages the document holds back to its workspace and its uploader. */
  releasePages(id: string): Promise<void>
  /** Deletes the document if it is still uploading; true when a row was deleted. */
  deleteUpload(id: string): Promise<boolean>
  /** release_stale_spend_reservations(): how many it released. */
  releaseStaleSpend(): Promise<number>
}

export interface PurgeResult {
  files_removed: number
  files_failed: number
  stale_uploads_removed: number
  reservations_released: number
}

/**
 * Steps 1 to 3: removes the files of documents 7 days old, a batch at a time, and sets
 * file_deleted_at only on a batch whose removal succeeded. The Storage API removes a batch or
 * fails it whole, and reports no error for an object already gone, which therefore counts as
 * removed. A failed batch keeps file_deleted_at null, so the next run retries it (US-14.1 AC-2);
 * this run goes on after it. Nothing but the file goes: fields, checks, ticks, history and the
 * approval stay (US-14.1 AC-5).
 */
async function removeExpiredFiles(deps: PurgeDeps, now: Date) {
  const before = new Date(now.getTime() - FILE_AGE_MS)
  let removed = 0
  let failed = 0
  let afterId: string | null = null
  for (;;) {
    const batch = await deps.selectExpired(before, afterId, BATCH_SIZE)
    if (batch.length === 0) break
    afterId = batch[batch.length - 1].id
    const paths = batch.flatMap((d) => (d.storage_path ? [d.storage_path] : []))
    try {
      if (paths.length > 0 && !(await deps.removeObjects(paths))) {
        failed += paths.length
      } else {
        await deps.markFileDeleted(
          batch.map((d) => d.id),
          now,
        )
        removed += paths.length
      }
    } catch (error) {
      // Files removed but not marked are removed again next run, as already gone, and marked.
      console.error('purge-files could not remove or mark a batch of files', error)
      failed += paths.length
    }
    if (batch.length < BATCH_SIZE) break
  }
  return { removed, failed }
}

/**
 * Step 4, first part: an upload left in status uploading for an hour, because the browser stopped
 * or submit-document failed after reserve_pages (ruling 3), is removed with its object. Its pages
 * are given back first, so the account and the workspace get them back. If the object cannot be
 * removed, the row stays, pages and all, for the next run.
 */
async function removeStaleUploads(deps: PurgeDeps, now: Date) {
  const before = new Date(now.getTime() - STALE_UPLOAD_MS)
  let removed = 0
  let afterId: string | null = null
  for (;;) {
    const batch = await deps.selectStaleUploads(before, afterId, BATCH_SIZE)
    if (batch.length === 0) break
    afterId = batch[batch.length - 1].id
    for (const doc of batch) {
      try {
        if (doc.storage_path && !doc.file_deleted_at && !(await deps.removeObjects([doc.storage_path]))) continue
        if (doc.pages_reserved) await deps.releasePages(doc.id)
        if (await deps.deleteUpload(doc.id)) removed++
      } catch (error) {
        console.error('purge-files could not remove the stale upload', doc.id, error)
      }
    }
    if (batch.length < BATCH_SIZE) break
  }
  return removed
}

/** One run of the daily job: files, stale uploads, then stale spend reservations (step 4). */
export async function purgeFiles(deps: PurgeDeps): Promise<PurgeResult> {
  const now = deps.now()
  const files = await removeExpiredFiles(deps, now)
  const staleUploads = await removeStaleUploads(deps, now)
  const reservations = await deps.releaseStaleSpend()
  return {
    files_removed: files.removed,
    files_failed: files.failed,
    stale_uploads_removed: staleUploads,
    reservations_released: reservations,
  }
}
