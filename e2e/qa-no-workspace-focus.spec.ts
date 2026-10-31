import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { switcher } from './support/workspace'

// Issue #17, criteria 1 and 3: the Create workspace dialog, opened from the page a user in no
// workspace sees, closes on a successful submit with keyboard focus on the workspace switcher's
// trigger ("Workspace: ..."), not on <body>. At phone width (OQ-40).
test.use({ viewport: { width: 360, height: 740 } })

test('creating a workspace from the no-workspace page leaves focus on the switcher', async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createUser()
  await signIn(context, baseURL!, user)
  await sql('delete from public.workspace_members where user_id = $1', [user.id])
  await page.goto('/documents')

  await page.getByRole('main').getByRole('button', { name: 'Create workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create workspace' })
  await dialog.getByLabel('Name').fill('Fresh start')
  await page.keyboard.press('Enter')

  await expect(dialog).toBeHidden()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Fresh start')
  await expect(switcher(page)).toBeFocused()
})
