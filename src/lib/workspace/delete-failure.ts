import { DELETE_FAILED } from '../account/memberships'

// What the delete workspace dialog says when DELETE /api/workspaces/[id] does not delete (issue
// #132, criterion 2), by the status deleteWorkspace (./delete.ts) answers with. A 500 is any
// failure after the checks, and a status the handler never sends, or no answer at all (the
// network), cannot be told apart either: those keep the generic message. No server-only import,
// because the dialog uses it.

export const DELETE_SIGNED_OUT = 'You are signed out. Sign in again, then delete the workspace.'
export const DELETE_NOT_OWNER = 'Only an owner can delete this workspace, and you are no longer one of its owners.'
export const DELETE_GONE = 'This workspace no longer exists. It may have been deleted already.'

/** The dialog's message for a response status, or for no response (null). */
export function deleteFailureMessage(status: number | null): string {
  switch (status) {
    case 401:
      return DELETE_SIGNED_OUT
    case 403:
      return DELETE_NOT_OWNER
    case 404:
      return DELETE_GONE
    default:
      return DELETE_FAILED
  }
}
