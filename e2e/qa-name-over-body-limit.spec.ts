import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { personalWorkspace, switcher } from './support/workspace'

// Issue #80: with maxLength gone, "the over-limit message from the action is what a user sees", and
// what was typed "is still in the field after any refusal". A paste larger than a server action's
// body limit (1 MB by default) must end the same way as one of 101 characters.

const LIMIT_MESSAGE = 'Use 100 characters or fewer for the workspace name.'
const PASTED = 'W'.repeat(1_100_000)

function recordProblems(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 500) problems.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
  return problems
}

for (const [label, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    test('a paste over 1 MB in the create form shows the limit message and stays in the field', async ({ page, context, baseURL }) => {
      const problems = recordProblems(page)
      await signIn(context, baseURL!, await createUser())
      await page.goto('/documents')

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Create workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create workspace' })
      const field = dialog.getByLabel('Name')
      await field.fill(PASTED)
      await dialog.getByRole('button', { name: 'Create' }).click()

      await expect(dialog.getByRole('alert')).toHaveText(LIMIT_MESSAGE)
      expect(await field.inputValue()).toHaveLength(PASTED.length)
      expect(problems).toEqual([])
    })

    test('a paste over 1 MB in the rename form shows the limit message and stays in the field', async ({ page, context, baseURL }) => {
      const problems = recordProblems(page)
      const user = await createUser()
      await personalWorkspace(user, 'Start')
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Rename workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Rename workspace' })
      const field = dialog.getByLabel('Name')
      await field.fill(PASTED)
      await dialog.getByRole('button', { name: 'Save' }).click()

      await expect(dialog.getByRole('alert')).toHaveText(LIMIT_MESSAGE)
      expect(await field.inputValue()).toHaveLength(PASTED.length)
      expect(problems).toEqual([])
    })
  })
}
