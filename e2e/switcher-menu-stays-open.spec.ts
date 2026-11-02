import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { switcher } from './support/workspace'

// Issue #97: the workspace switcher's menu, opened right after a switch that followed a dialog,
// closed by itself. A menu the user opened stays open until the user closes it or picks an item.

/**
 * Counts every time the switcher's button stops saying its menu is open, or leaves the page taking
 * the menu with it, from here on. It watches the button rather than the menu because the menu just
 * picked from may still be finishing its exit animation, and its leaving is not a close. Written in
 * the page, so a close that is over between two checks from the test is still counted.
 */
async function watchForMenuCloses(page: Page) {
  await page.evaluate(() => {
    const state = { closes: 0 }
    ;(window as unknown as { menuWatch: typeof state }).menuWatch = state
    const button = 'button[aria-haspopup="menu"]'
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if ((record.target as Element).matches(button) && record.oldValue === 'true') state.closes += 1
          continue
        }
        for (const node of record.removedNodes) {
          if (node instanceof Element && (node.matches(button) || node.querySelector(button))) state.closes += 1
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ['aria-expanded'],
      attributeOldValue: true,
    })
  })
}

function menuCloses(page: Page) {
  return page.evaluate(() => (window as unknown as { menuWatch: { closes: number } }).menuWatch.closes)
}

test('the menu opened right after a switch that followed a dialog stays open', async ({ page, context, baseURL }) => {
  const user = await createUser()
  await sql(
    `with ws as (insert into public.workspaces (name, created_by) values ('Shared books', $1) returning id)
     insert into public.workspace_members (workspace_id, user_id, role) select id, $1, 'owner' from ws`,
    [user.id],
  )
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')

  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete workspace' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await switcher(page).click()
  await page.getByRole('menuitemradio', { name: 'Shared books' }).click()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Shared books')

  await watchForMenuCloses(page)
  await switcher(page).click()
  const members = page.getByRole('menuitem', { name: 'Members' })
  await expect(members).toBeVisible()

  await page.waitForTimeout(2000)

  expect(await menuCloses(page), 'times the menu closed by itself').toBe(0)
  await expect(members).toBeVisible()
  await members.click()
  await expect(page).toHaveURL(/\/members$/)
})
