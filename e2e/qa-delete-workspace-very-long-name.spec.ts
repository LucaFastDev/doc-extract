import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { personalWorkspace, switcher } from './support/workspace'

// Issue #61 criterion 7 and ruling 10: an owner deletes a workspace by typing its name and pressing
// Delete workspace, and a long name still wraps. Rename and Create set no maximum length, and the
// dialog repeats the name twice, so a long enough name makes the dialog taller than the window. The
// dialog does not scroll, so its button is below the bottom of the window, out of reach.

// The name's length is what it takes to push the button fully off each window.
for (const [label, viewport, length] of [
  ['phone', { width: 360, height: 740 }, 1000],
  ['desktop', { width: 1280, height: 800 }, 1500],
] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    test(`Delete workspace can be reached and pressed with a ${length}-character name`, async ({ page, context, baseURL }) => {
      const owner = await createUser()
      const name = 'Long words here '.repeat(Math.ceil(length / 16)).slice(0, length).trim()
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
