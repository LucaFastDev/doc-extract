import {
  ACCEPTED_TYPES_LABEL,
  isAcceptedMimeType,
  isImageMimeType,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_LABEL,
  pages,
} from '@shared/limits'

// What the upload control checks before anything is uploaded (PRD US-1.1 AC-2 to AC-4), and how
// the document list names statuses and types (US-10.1 AC-1). submit-document checks the file again.

export interface ChosenFile {
  name: string
  type: string
  size: number
}

/** Every reason the selection is refused; empty when it may be uploaded. */
export function checkSelection(files: ChosenFile[]): string[] {
  if (files.length === 0) return ['Choose at least one file.']
  if (files.length > MAX_FILES) return [`You can upload at most ${MAX_FILES} files at once.`]
  const problems: string[] = []
  for (const f of files) {
    if (!isAcceptedMimeType(f.type)) {
      problems.push(`${f.name} is not a PDF, JPEG, PNG or WebP file. Accepted types: ${ACCEPTED_TYPES_LABEL}.`)
    } else if (isImageMimeType(f.type) && f.size > MAX_IMAGE_BYTES) {
      problems.push(`${f.name} is over the ${MAX_IMAGE_LABEL} limit for images.`)
    } else if (f.size > MAX_FILE_BYTES) {
      problems.push(`${f.name} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`)
    } else if (f.size === 0) {
      problems.push(`${f.name} is empty.`)
    }
  }
  return problems
}

/** The statuses the list shows. uploading and rejected rows are never listed (ARCHITECTURE.md 2). */
export const STATUS_LABELS = {
  queued: 'Queued',
  processing: 'Processing',
  waiting_budget: 'Waiting for budget',
  needs_review: 'Needs review',
  approved: 'Approved',
  failed: 'Failed',
  unsupported: 'Not supported',
} as const

export type ListedStatus = keyof typeof STATUS_LABELS

export const LISTED_STATUSES = Object.keys(STATUS_LABELS) as ListedStatus[]

export function isListed(status: string): status is ListedStatus {
  return status in STATUS_LABELS
}

export const DOC_TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  bank_statement: 'Bank statement',
  purchase_order: 'Purchase order',
  delivery_note: 'Delivery note',
  quote: 'Quote',
}

/** What get_page_allowance returns. */
export interface PageAllowance {
  workspace_used: number
  workspace_limit: number
  account_used: number
  /** null when app_config turns the account cap off. */
  account_cap: number | null
}

/** The statuses whose reason the list shows (issue #24, criterion 10). */
const REASON_SHOWN: readonly string[] = ['failed', 'unsupported', 'waiting_budget']

/** Why a document failed, is not supported or is waiting for budget; null for any other. */
export function statusReason(doc: { status: ListedStatus; status_reason: string | null }): string | null {
  if (!REASON_SHOWN.includes(doc.status)) return null
  const reason = doc.status_reason?.trim()
  return reason ? reason : null
}

/** Retry is offered on a failed document whose file is still there (PRD US-2.1 AC-6, AC-7). */
export function canRetry(doc: { status: ListedStatus; file_deleted_at: string | null }): boolean {
  return doc.status === 'failed' && doc.file_deleted_at === null
}

// The list's live state, which the hidden live-status element reports. A joined channel is not yet
// receiving changes: Realtime then confirms or refuses the postgres_changes subscription in a
// system message, so only that confirmation makes the list "subscribed", and a refusal is an error.

/** The live state for a status passed to the channel's subscribe callback. */
export function channelLiveState(status: string): string {
  return status === 'SUBSCRIBED' ? 'joined' : status.toLowerCase()
}

/** The live state for a system message on the channel, or null when it changes nothing. */
export function systemLiveState(message: { extension?: string; status?: string }): string | null {
  if (message.status === 'error') return 'channel_error'
  if (message.extension === 'postgres_changes' && message.status === 'ok') return 'subscribed'
  return null
}

/** The pages left, for the upload screen (PRD US-13.2 AC-3). */
export function allowanceSummary(a: PageAllowance) {
  const workspaceLeft = Math.max(0, a.workspace_limit - a.workspace_used)
  return {
    // No account line when app_config turns the account cap off.
    account:
      a.account_cap === null
        ? null
        : `${Math.max(0, a.account_cap - a.account_used)} of your account’s ${pages(a.account_cap)} left`,
    workspace: `${workspaceLeft} of this workspace’s ${pages(a.workspace_limit)} left this month`,
  }
}
