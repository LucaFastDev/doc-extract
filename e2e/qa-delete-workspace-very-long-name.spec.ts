import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { personalWorkspace, switcher } from './support/workspace'

// Issue #61 criterion 7 and ruling 10: an owner deletes a workspace by typing its name and pressing
// Delete workspace, and a long name still wraps. The dialog repeats the name twice. The name here
// is the longest a workspace can have (issue #69), with no spaces.

for (const [label, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    test('Delete workspace can be reached and pressed with a 100-character name', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      const name = 'W'.repeat(100)
      const ws = await personalWorkspace(owner, name)
      await signIn(context, baseURL!, owner)
      await page.goto('/documents')

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Delete workspace' })
      await dialog.getByRole('textbox').fill(name)
      const button = dialog.getByRole('button', { name: 'Delete workspace' })
      await expect(button).toBeEnabled()

      await button.click({ timeout: 5_000 })

      await expect(page.getByText('You are not in any workspace.')).toBeVisible()
      expect(await sql('select 1 from public.workspaces where id = $1', [ws])).toEqual([])
    })
  })
}
