import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { switcher } from './support/workspace'

// PRD US-18.1 AC-1, issue #61 criterion 7 and ruling 8: an owner deletes a workspace after typing
// its name, and the field's label "Type <name> to confirm" tells them what to type. A name with
// more than one space in a row is accepted by Rename and Create, so what the dialog shows has to be
// what the gate accepts: typing the name as the dialog shows it enables the button.

for (const [label, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    test('typing the name as the dialog shows it enables Delete workspace, also with two spaces in the name', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      await signIn(context, baseURL!, owner)
      await page.goto('/documents')

      // A slip of the thumb, saved through the app's own Rename dialog.
      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Rename workspace' }).click()
      const rename = page.getByRole('dialog', { name: 'Rename workspace' })
      await rename.getByLabel('Name').fill('Acme  Ltd')
      await rename.getByRole('button', { name: 'Save' }).click()
      await expect(rename).toBeHidden()

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Delete workspace' })

      // innerText is what the browser renders, so what the owner reads and types.
      const shown = await dialog.locator('label').innerText()
      const typed = shown.replace(/^Type /, '').replace(/ to confirm$/, '')
      await dialog.getByRole('textbox').fill(typed)
      await expect(dialog.getByRole('button', { name: 'Delete workspace' })).toBeEnabled()

      await dialog.getByRole('button', { name: 'Delete workspace' }).click()
      await expect(page.getByText('You are not in any workspace.')).toBeVisible()
      expect(await sql('select 1 from public.workspace_members where user_id = $1', [owner.id])).toEqual([])
    })
  })
}
