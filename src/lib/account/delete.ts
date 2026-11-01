import { removeWorkspace, type DeleteWorkspaceDeps } from '../workspace/delete'
import { DELETE_FAILED, readMembers, refusalMessage, sortAccountWorkspaces } from './memberships'

// Deleting an account (ARCHITECTURE.md section 6.2, PRD US-18.2, OQ-20, OQ-30, issue #61 rulings 5
// and 6), behind DELETE /api/account. Deleting the user cascades to their profile, memberships and
// account_page_usage row, and sets their audit columns elsewhere to null.
// tests/access/deletion.test.ts runs this with real clients and a fake Stripe.

export interface DeleteAccountResult {
  status: 204 | 401 | 409 | 500
  error?: string
  /** On 409, the workspaces the caller is the only owner of. */
  workspaces?: string[]
}

/**
 * Refuses first, changing nothing, while the caller is the only owner of a workspace with other
 * members. Then the workspaces they are alone in go, one at a time, then the user, so a failure
 * keeps the user and running it again finishes the job.
 */
export async function deleteAccount({ asCaller, admin, stripe }: DeleteWorkspaceDeps): Promise<DeleteAccountResult> {
  try {
    const {
      data: { user },
    } = await asCaller.auth.getUser()
    if (!user) return { status: 401, error: 'Sign in to delete your account.' }

    const { soleMember, onlyOwner } = sortAccountWorkspaces(await readMembers(asCaller), user.id)
    if (onlyOwner.length > 0) {
      const names = onlyOwner.map((w) => w.name)
      return { status: 409, error: refusalMessage(names), workspaces: names }
    }

    for (const workspace of soleMember) await removeWorkspace(workspace.id, { admin, stripe })
    const { error } = await admin().auth.admin.deleteUser(user.id)
    if (error) throw error
  } catch (error) {
    console.error('An account could not be deleted.', error)
    return { status: 500, error: DELETE_FAILED }
  }

  // The user no longer exists, so a failure here changes nothing the caller can act on.
  try {
    const { error } = await asCaller.auth.signOut({ scope: 'local' })
    if (error) throw error
  } catch (error) {
    console.error('The session of a deleted account could not be cleared.', error)
  }
  return { status: 204 }
}
