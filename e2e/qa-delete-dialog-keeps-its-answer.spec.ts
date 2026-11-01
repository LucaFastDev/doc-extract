import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { addMember, personalWorkspace, switcher } from './support/workspace'

// Issue #61, ruling 8: a failure in either dialog shows, with role="alert", the dialog staying open;
// a refusal shows its sentence in the dialog. Cancel is disabled while the request runs, but Escape
// and a press outside the dialog still close it, so the answer has nowhere to show and the owner
// never learns the deletion did not happen.

const FAILURE = 'This could not be deleted. Try again.'

/** Holds the matching request until released, so the dialog is dismissed while it is in flight. */
async function holdRequests(page: Page, url: string) {
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(url, async (route) => {
    await held
    await route.continue()
  })
  return release
}

const dismissals: [string, (page: Page) => Promise<void>][] = [
  ['Escape', (page) => page.keyboard.press('Escape')],
  ['a press outside the dialog', (page) => page.mouse.click(4, 4)],
]

for (const [label, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    for (const [how, dismiss] of dismissals) {
      test(`a refusal still shows in the account dialog after ${how} while the request runs`, async ({ page, context, baseURL }) => {
        const user = await createUser()
        const teammate = await createUser()
        const ws = await personalWorkspace(user, 'Shared books')
        await addMember(ws, teammate, 'member')
        await signIn(context, baseURL!, user)
        await page.goto('/documents')

        const release = await holdRequests(page, '**/api/account')
        await page.getByRole('banner').getByRole('button', { name: 'Delete account' }).click()
        const dialog = page.getByRole('dialog', { name: 'Delete your account' })
        const sent = page.waitForRequest('**/api/account')
        await dialog.getByRole('button', { name: 'Delete my account' }).click()
        await sent

        await dismiss(page)
        release()

        await expect(dialog.getByRole('alert')).toHaveText(
          'You are the only owner of Shared books, which still have other members. Make another member an owner of each, or delete it first.',
        )
      })

      test(`a failure still shows in the workspace dialog after ${how} while the request runs`, async ({ page, context, baseURL }) => {
        const user = await createUser()
        const name = 'Still here'
        await personalWorkspace(user, name)
        await signIn(context, baseURL!, user)
        await page.goto('/documents')

        let release = () => {}
        const held = new Promise<void>((resolve) => (release = resolve))
        await page.route('**/api/workspaces/*', async (route) => {
          await held
          await route.fulfill({ status: 500, json: { error: 'no' } })
        })
        await switcher(page).click()
        await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
        const dialog = page.getByRole('dialog', { name: 'Delete workspace' })
        await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
        const sent = page.waitForRequest('**/api/workspaces/*')
        await dialog.getByRole('button', { name: 'Delete workspace' }).click()
        await sent

        await dismiss(page)
        release()

        await expect(dialog.getByRole('alert')).toHaveText(FAILURE)
      })
    }
  })
}
