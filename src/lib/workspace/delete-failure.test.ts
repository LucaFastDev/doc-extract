import { describe, expect, it } from 'vitest'
import { DELETE_FAILED } from '../account/memberships'
import { DELETE_GONE, DELETE_NOT_OWNER, DELETE_SIGNED_OUT, deleteFailureMessage } from './delete-failure'

// Issue #132, criterion 2: each failure DELETE /api/workspaces/[id] can answer with has its own
// message in the dialog; anything that cannot be told apart keeps the generic one.

describe('deleteFailureMessage', () => {
  it('names the reason for each refusal the route sends', () => {
    expect(deleteFailureMessage(401)).toBe('You are signed out. Sign in again, then delete the workspace.')
    expect(deleteFailureMessage(401)).toBe(DELETE_SIGNED_OUT)
    expect(deleteFailureMessage(403)).toBe('Only an owner can delete this workspace, and you are no longer one of its owners.')
    expect(deleteFailureMessage(403)).toBe(DELETE_NOT_OWNER)
    expect(deleteFailureMessage(404)).toBe('This workspace no longer exists. It may have been deleted already.')
    expect(deleteFailureMessage(404)).toBe(DELETE_GONE)
  })

  it('keeps the generic message for a server failure, any other status and no answer', () => {
    expect(DELETE_FAILED).toBe('This could not be deleted. Try again.')
    for (const status of [500, 502, 503, 400, 405, 200, null]) expect(deleteFailureMessage(status), String(status)).toBe(DELETE_FAILED)
  })
})
