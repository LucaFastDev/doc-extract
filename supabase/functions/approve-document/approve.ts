import { DOC_TYPES, type DocType } from '../../../shared/doctypes/index.ts'
import { utcDate } from '../../../shared/doctypes/checks.ts'
import { currentValue, recheck, type StoredField } from '../../../shared/doctypes/review.ts'
import type { CheckResult } from '../../../shared/doctypes/fields.ts'

// approve-document's steps (ARCHITECTURE.md section 6.1, PRD US-5.1 AC-5 and AC-6, OQ-11), with
// the database behind ApproveDeps so the unit tests run them without it. index.ts supplies the
// real ones. The checks run here on the corrected values, as the review screen ran them; U1 and
// the approval itself run in approve_document, in one transaction (Lead ruling 2 on #32).

export interface ApprovedDocument {
  id: string
  workspace_id: string
  status: string
  doc_type: string | null
  file_name: string
}

/** What approve_document is given: the values the checks read, their results and the flags. */
export interface ApprovalInput {
  values: Record<string, string | null>
  checks: CheckResult[]
  flags: Record<string, string[]>
  duplicate: { key: string | null; label: string; flag_paths: string[] }
}

export type ApprovalOutcome =
  | { outcome: 'approved'; approved_at: string }
  | { outcome: 'unticked'; checks: string[] }
  | { outcome: 'changed' }
  | { outcome: 'wrong_status'; status: string }
  | { outcome: 'not_found' }

export interface ApproveDeps {
  /** The caller, from their JWT; null when it is missing or invalid. */
  userId(): Promise<string | null>
  /** The document read as the caller, so RLS returns it only to a member of its workspace. */
  loadDocument(id: string): Promise<ApprovedDocument | null>
  /** is_member, as the caller. */
  isMember(workspaceId: string): Promise<boolean>
  /** The document's extraction_fields rows, read as the caller. */
  loadFields(id: string): Promise<StoredField[]>
  /** app_config.amount_tolerance (OQ-7). */
  amountTolerance(): Promise<string>
  now(): Date
  /** approve_document, with the service role. */
  approve(id: string, actor: string, input: ApprovalInput): Promise<ApprovalOutcome>
}

export interface ApproveResult {
  status: number
  body:
    | { error: string; unticked?: string[] }
    | { document: { id: string; status: 'approved'; approved_by: string; approved_at: string } }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NOT_FOUND: ApproveResult = { status: 404, body: { error: 'This document does not exist.' } }

/** The values, results and flags of the document's checks on its current values. */
export function approvalInput(docType: DocType, rows: StoredField[], amountTolerance: string, today: string): ApprovalInput {
  const { checks, flags, duplicate } = recheck(DOC_TYPES[docType], rows, { amountTolerance, today })
  return {
    values: Object.fromEntries(rows.map((r) => [r.path, currentValue(r)])),
    checks,
    flags,
    duplicate: { key: duplicate.key, label: duplicate.label, flag_paths: duplicate.flag_paths },
  }
}

/** "A2", "A2 and U1", "A1, A2 and U1". */
export function listChecks(ids: string[]): string {
  return ids.length <= 1 ? (ids[0] ?? '') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
}

/**
 * Checks the caller and the document, re-runs the checks on the corrected values, and has
 * approve_document store them and approve, or refuse while a failed check has no tick.
 */
export async function approveDocument(body: unknown, deps: ApproveDeps): Promise<ApproveResult> {
  const documentId = (body as { document_id?: unknown } | null)?.document_id
  if (typeof documentId !== 'string' || !UUID.test(documentId)) {
    return { status: 400, body: { error: 'Send the document_id of the document to approve.' } }
  }
  const actor = await deps.userId()
  if (!actor) return { status: 401, body: { error: 'Sign in to approve documents.' } }

  const doc = await deps.loadDocument(documentId)
  if (!doc || !(await deps.isMember(doc.workspace_id))) return NOT_FOUND
  if (doc.status !== 'needs_review' || !doc.doc_type || !(doc.doc_type in DOC_TYPES)) {
    return { status: 409, body: { error: `${doc.file_name} cannot be approved: it does not need review.` } }
  }

  const rows = await deps.loadFields(doc.id)
  const input = approvalInput(doc.doc_type as DocType, rows, await deps.amountTolerance(), utcDate(deps.now()))
  const result = await deps.approve(doc.id, actor, input)
  switch (result.outcome) {
    case 'approved':
      return { status: 200, body: { document: { id: doc.id, status: 'approved', approved_by: actor, approved_at: result.approved_at } } }
    case 'unticked': {
      const n = result.checks.length
      return {
        status: 409,
        body: {
          error: `Tick the failed ${n === 1 ? 'check' : 'checks'} ${listChecks(result.checks)} before approving.`,
          unticked: result.checks,
        },
      }
    }
    case 'changed':
      return { status: 409, body: { error: `${doc.file_name} changed while it was being approved. Try again.` } }
    case 'wrong_status':
      return { status: 409, body: { error: `${doc.file_name} cannot be approved: it does not need review.` } }
    default:
      return NOT_FOUND
  }
}
