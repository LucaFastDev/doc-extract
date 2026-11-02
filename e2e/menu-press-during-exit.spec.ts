import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { centreOf, escapeThenPress, openByPointer } from './support/menu'
import { addMember, personalWorkspace, roleOf, switcher } from './support/workspace'

// Issue #102: a closed menu stays on the page and takes pointer presses until its exit animation
// ends. Each test presses Escape and then a plain left button at once, and checks the press really
// met the closing menu, so a press that came too late fails rather than passing for the wrong reason.

/** An owner on the members page, with Mia Member's menu open. */
async function openMemberMenu(page: Page, context: BrowserContext, baseURL: string) {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const member = await createUser('Mia Member')
  await addMember(ws, member, 'member')
  await signIn(context, baseURL, owner)
  await page.goto('/members')
  const button = page.getByRole('button', { name: 'Change Mia Member' })
  const makeOwner = page.getByRole('menuitem', { name: 'Make owner' })
  await openByPointer(button, makeOwner)
  return { ws, member, button, makeOwner, row: page.getByRole('listitem', { name: 'Mia Member' }) }
}

test('a press on Make owner right after Escape does not make the member an owner', async ({
  page,
  context,
  baseURL,
}) => {
  const { ws, member, makeOwner, row } = await openMemberMenu(page, context, baseURL!)

  const met = await escapeThenPress(page, await centreOf(makeOwner))
  await page.waitForTimeout(2000)

  expect(met.onClosingMenu, 'the press landed on the closing menu').toBe(true)
  await expect(row).toHaveText(/Member$/)
  await page.reload()
  await expect(row).toHaveText(/Member$/)
  expect(await roleOf(ws, member)).toBe('member')
})

test('a press on another workspace right after Escape does not switch workspace', async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createUser()
  await sql(
    `with ws as (insert into public.workspaces (name, created_by) values ('Shared books', $1) returning id)
     insert into public.workspace_members (workspace_id, user_id, role) select id, $1, 'owner' from ws`,
    [user.id],
  )
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
  const sharedBooks = page.getByRole('menuitemradio', { name: 'Shared books' })
  await openByPointer(switcher(page), sharedBooks)

  const met = await escapeThenPress(page, await centreOf(sharedBooks))
  await page.waitForTimeout(2000)

  expect(met.onClosingMenu, 'the press landed on the closing menu').toBe(true)
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
  await page.reload()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
})

test('a press on the member menu button right after Escape leaves the menu open', async ({
  page,
  context,
  baseURL,
}) => {
  const { ws, member, button, makeOwner, row } = await openMemberMenu(page, context, baseURL!)

  const met = await escapeThenPress(page, await centreOf(button))
  await page.waitForTimeout(2000)

  expect(met.menuClosing, 'the press came while the menu was closing').toBe(true)
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(makeOwner).toBeVisible()
  await makeOwner.click()
  await expect(row).toHaveText(/Owner$/)
  expect(await roleOf(ws, member)).toBe('owner')
})
