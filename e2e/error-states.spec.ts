import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { adminClient, createUser, signIn, sql, type TestUser } from './support/auth'
import { pngFile } from './support/files'
import { addMember, expectNoSideScroll, personalWorkspace, switcher } from './support/workspace'

// Issue #132: clearer error states. Criterion 1, a Failed row whose file the purge removed; and
// criterion 2, the delete workspace dialog naming the reason for each failure the route sends,
// with the generic message kept for one it cannot tell apart. The error pages (criterion 3) are
// rendered by src/app/error.test.ts.

const FILE_REMOVED = 'The file was removed. Upload it again to try once more.'
const RETRY_LATER = 'Extraction failed 3 times. The last time, Claude was overloaded. Retry later.'

function row(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name })
}

/** A Failed document in the user's workspace, as process-queue leaves it; its file in Storage or purged. */
async function failedDocument(user: TestUser, name: string, file: 'present' | 'removed') {
  const [{ workspace_id: ws }] = await sql<{ workspace_id: string }>('select workspace_id from public.workspace_members where user_id = $1', [user.id])
  const id = randomUUID()
  const path = `${ws}/${id}/original`
  if (file === 'present') {
    const { error } = await adminClient().storage.from('documents').upload(path, pngFile(name).buffer, { contentType: 'image/png' })
    if (error) throw error
  }
  await sql(
    `insert into public.documents (id, workspace_id, uploaded_by, status, status_reason, file_name, mime_type, byte_size, page_count, storage_path, file_deleted_at)
     values ($1, $2, $3, 'failed', $4, $5, 'image/png', 16, 1, $6, ${file === 'removed' ? 'now()' : 'null'})`,
    [id, ws, user.id, RETRY_LATER, name, path],
  )
}

for (const [label, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    test('a Failed row whose file was removed says so and offers only Delete; one whose file is there is unchanged', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser()
      const suffix = randomUUID().slice(0, 6)
      const removed = `Purged scan ${suffix}.png`
      const present = `Kept scan ${suffix}.png`
      await failedDocument(user, removed, 'removed')
      await failedDocument(user, present, 'present')
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      const gone = row(page, removed)
      await expect(gone.getByRole('cell').first()).toHaveText(`${removed}${FILE_REMOVED}`)
      await expect(gone).not.toContainText('Retry later')
      await expect(gone.getByRole('button', { name: /Retry/ })).toHaveCount(0)
      await expect(gone.getByRole('link')).toHaveCount(0)
      await expect(gone.getByRole('button')).toHaveCount(1)
      await expect(gone.getByRole('button', { name: `Delete ${removed}` })).toBeVisible()

      const kept = row(page, present)
      await expect(kept).toContainText(RETRY_LATER)
      await expect(kept).not.toContainText(FILE_REMOVED)
      await expect(kept.getByRole('button', { name: `Retry ${present}` })).toBeVisible()
      await expect(kept.getByRole('button', { name: `Delete ${present}` })).toBeVisible()
      if (label === 'phone') await expectNoSideScroll(page)

      // Delete still works on the row whose file was removed.
      await gone.getByRole('button', { name: `Delete ${removed}` }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(gone).toHaveCount(0)
      await expect(kept).toBeVisible()
    })
  })
}

test.describe('the delete workspace dialog', () => {
  /** Signs the owner in on the list and opens the dialog with the name typed, ready to submit. */
  async function openDialog(page: Page, context: Parameters<typeof signIn>[0], baseURL: string, user: TestUser, name: string) {
    await signIn(context, baseURL, user)
    await page.goto('/documents')
    await switcher(page).click()
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete workspace' })
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
    return dialog
  }

  /** Submits and waits for the route's answer, returning its status. */
  async function submit(page: Page, dialog: ReturnType<Page['getByRole']>) {
    const answered = page.waitForResponse((response) => /\/api\/workspaces\/[^/]+$/.test(new URL(response.url()).pathname))
    await dialog.getByRole('button', { name: 'Delete workspace' }).click()
    return (await answered).status()
  }

  test('says the user is no longer an owner when the route refuses with 403', async ({ page, context, baseURL }) => {
    const user = await createUser()
    const other = await createUser()
    const name = `Demoted ${randomUUID().slice(0, 6)}`
    const ws = await personalWorkspace(user, name)
    await addMember(ws, other, 'owner')
    const dialog = await openDialog(page, context, baseURL!, user, name)

    // Another owner makes them a member while the dialog is open.
    await sql("update public.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [ws, user.id])
    expect(await submit(page, dialog)).toBe(403)
    await expect(dialog.getByRole('alert')).toHaveText('Only an owner can delete this workspace, and you are no longer one of its owners.')
    expect(await sql('select 1 from public.workspaces where id = $1', [ws])).toHaveLength(1)
  })

  test('says the workspace no longer exists when the route answers 404', async ({ page, context, baseURL }) => {
    const user = await createUser()
    const name = `Gone ${randomUUID().slice(0, 6)}`
    const ws = await personalWorkspace(user, name)
    const dialog = await openDialog(page, context, baseURL!, user, name)

    // Deleted from elsewhere while the dialog is open.
    await sql('delete from public.workspaces where id = $1', [ws])
    expect(await submit(page, dialog)).toBe(404)
    await expect(dialog.getByRole('alert')).toHaveText('This workspace no longer exists. It may have been deleted already.')
  })

  test('says the user is signed out when the route answers 401', async ({ page, context, baseURL }) => {
    const user = await createUser()
    const name = `Signed out ${randomUUID().slice(0, 6)}`
    const ws = await personalWorkspace(user, name)
    const dialog = await openDialog(page, context, baseURL!, user, name)

    await context.clearCookies()
    expect(await submit(page, dialog)).toBe(401)
    await expect(dialog.getByRole('alert')).toHaveText('You are signed out. Sign in again, then delete the workspace.')
    expect(await sql('select 1 from public.workspaces where id = $1', [ws])).toHaveLength(1)
  })

  test('keeps the generic message when the request gets no answer', async ({ page, context, baseURL }) => {
    const user = await createUser()
    const name = `Offline ${randomUUID().slice(0, 6)}`
    const ws = await personalWorkspace(user, name)
    const dialog = await openDialog(page, context, baseURL!, user, name)

    await page.route('**/api/workspaces/*', (route) => route.abort('internetdisconnected'))
    await dialog.getByRole('button', { name: 'Delete workspace' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('This could not be deleted. Try again.')
    expect(await sql('select 1 from public.workspaces where id = $1', [ws])).toHaveLength(1)
  })

  test('keeps the generic message when the server fails', async ({ page, context, baseURL }) => {
    const user = await createUser()
    const name = `Failing ${randomUUID().slice(0, 6)}`
    await personalWorkspace(user, name)
    const dialog = await openDialog(page, context, baseURL!, user, name)

    await page.route('**/api/workspaces/*', (route) => route.fulfill({ status: 500, json: { error: 'This could not be deleted. Try again.' } }))
    await dialog.getByRole('button', { name: 'Delete workspace' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('This could not be deleted. Try again.')
  })
})
