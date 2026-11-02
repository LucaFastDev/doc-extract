import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { centreOf, escapeThenPress, openByPointer } from './support/menu'
import { addMember, personalWorkspace, switcher } from './support/workspace'

// Around issue #102. A link item during the exit animation is followed by the browser unless the
// press is stopped, and the member menu's button keeps what it did for every press it does not toggle on.

/** An owner on the members page, with two members who each have a menu, and Noah Member's open. */
async function openMemberMenu(page: Page, context: BrowserContext, baseURL: string) {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  await addMember(ws, await createUser('Mia Member'), 'member')
  await addMember(ws, await createUser('Noah Member'), 'member')
  await signIn(context, baseURL, owner)
  await page.goto('/members')
  const button = page.getByRole('button', { name: 'Change Noah Member' })
  const item = page.getByRole('menuitem', { name: 'Make owner' })
  await openByPointer(button, item)
  return { button, item }
}

/** The press closes the open menu, and it stays closed. */
async function expectPressToCloseMenu(page: Page, button: Locator, item: Locator, press: Parameters<Locator['click']>[0]) {
  await button.click(press)
  await expect(button).toHaveAttribute('aria-expanded', 'false')

  await page.waitForTimeout(2000)

  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await expect(item).toBeHidden()
}

test('a press on a link in the menu right after Escape does not follow it', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto('/documents')
  const members = page.getByRole('menuitem', { name: 'Members' })
  await openByPointer(switcher(page), members)

  const met = await escapeThenPress(page, await centreOf(members))
  await page.waitForTimeout(2000)

  expect(met.onClosingMenu, 'the press landed on the closing menu').toBe(true)
  await expect(page).toHaveURL(/\/documents$/)
})

test('a right click on the member menu button closes the open menu', async ({ page, context, baseURL }) => {
  const { button, item } = await openMemberMenu(page, context, baseURL!)

  await expectPressToCloseMenu(page, button, item, { button: 'right' })
})

test('a Ctrl-click on the member menu button closes the open menu', async ({ page, context, baseURL }) => {
  const { button, item } = await openMemberMenu(page, context, baseURL!)

  await expectPressToCloseMenu(page, button, item, { modifiers: ['Control'] })
})

test("a press on another member's button closes the open menu and opens that one", async ({
  page,
  context,
  baseURL,
}) => {
  const { button } = await openMemberMenu(page, context, baseURL!)
  // The row above: Noah Member's open menu covers whatever is below its button.
  const other = page.getByRole('button', { name: 'Change Mia Member' })

  await other.click()

  await expect(other).toHaveAttribute('aria-expanded', 'true')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('menu')).toHaveCount(1)
})
