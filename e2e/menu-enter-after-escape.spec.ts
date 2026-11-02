import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { addMember, personalWorkspace, roleOf, switcher } from './support/workspace'

// Issue #100: a menu leaves the page only when its exit animation ends, and focus stays on its item
// until then, so Enter pressed right after Escape reached the item and ran what had just been
// cancelled. The first group presses the keys at once, with no wait between them. The second group
// is the keyboard use of a menu that must stay as it was, each step waiting for the one before.

/** Opens the menu from its button by keyboard. A press before the page is hydrated does nothing. */
async function openByKeyboard(page: Page, button: Locator, firstItem: Locator) {
  await button.focus()
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await page.keyboard.press('Enter')
    await expect(firstItem).toBeFocused({ timeout: 1000 })
  }).toPass()
}

/** A user with a second workspace, on the documents page, with the switcher's menu open by keyboard. */
async function openSwitcher(page: Page, context: BrowserContext, baseURL: string) {
  const user = await createUser()
  await sql(
    `with ws as (insert into public.workspaces (name, created_by) values ('Shared books', $1) returning id)
     insert into public.workspace_members (workspace_id, user_id, role) select id, $1, 'owner' from ws`,
    [user.id],
  )
  await signIn(context, baseURL, user)
  await page.goto('/documents')
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
  await openByKeyboard(page, switcher(page), page.getByRole('menuitemradio', { name: 'Personal' }))
}

async function focusSharedBooks(page: Page) {
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Shared books' })).toBeFocused()
}

/** An owner on the members page, with the member's menu open by keyboard and focus on Make owner. */
async function openMemberMenu(page: Page, context: BrowserContext, baseURL: string) {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const member = await createUser('Mia Member')
  await addMember(ws, member, 'member')
  await signIn(context, baseURL, owner)
  await page.goto('/members')
  const button = page.getByRole('button', { name: 'Change Mia Member' })
  await openByKeyboard(page, button, page.getByRole('menuitem', { name: 'Make owner' }))
  return { ws, member, button, row: page.getByRole('listitem', { name: 'Mia Member' }) }
}

async function expectStillPersonal(page: Page) {
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
  await page.reload()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
}

test('Enter right after Escape does not switch workspace', async ({ page, context, baseURL }) => {
  await openSwitcher(page, context, baseURL!)
  await focusSharedBooks(page)

  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)

  await expectStillPersonal(page)
})

test('Space right after Escape does not switch workspace', async ({ page, context, baseURL }) => {
  await openSwitcher(page, context, baseURL!)
  await focusSharedBooks(page)

  await page.keyboard.press('Escape')
  await page.keyboard.press('Space')
  await page.waitForTimeout(2000)

  await expectStillPersonal(page)
})

test('Enter right after Escape does not follow a link in the menu', async ({ page, context, baseURL }) => {
  await openSwitcher(page, context, baseURL!)
  await focusSharedBooks(page)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Members' })).toBeFocused()

  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)

  await expect(page).toHaveURL(/\/documents$/)
})

test('Enter right after Escape does not make a member an owner', async ({ page, context, baseURL }) => {
  const { ws, member, row } = await openMemberMenu(page, context, baseURL!)

  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)

  await expect(row).toHaveText(/Member$/)
  await page.reload()
  await expect(row).toHaveText(/Member$/)
  expect(await roleOf(ws, member)).toBe('member')
})

test('the switcher by keyboard: Escape returns focus, Enter reopens, arrows move, Enter runs', async ({
  page,
  context,
  baseURL,
}) => {
  await openSwitcher(page, context, baseURL!)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(switcher(page)).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitemradio', { name: 'Personal' })).toBeFocused()
  await focusSharedBooks(page)
  await page.keyboard.press('Enter')

  await expect(switcher(page)).toHaveAccessibleName('Workspace: Shared books')
})

test('a link in the menu by keyboard: Enter follows it', async ({ page, context, baseURL }) => {
  await openSwitcher(page, context, baseURL!)
  await focusSharedBooks(page)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Members' })).toBeFocused()

  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(/\/members$/)
})

test('the member menu by keyboard: Escape returns focus, Enter reopens, Enter on Make owner runs it', async ({
  page,
  context,
  baseURL,
}) => {
  const { ws, member, button, row } = await openMemberMenu(page, context, baseURL!)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(button).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Make owner' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(row).toHaveText(/Owner$/)
  expect(await roleOf(ws, member)).toBe('owner')
})
