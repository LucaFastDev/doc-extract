import { expect, test } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { centreOf, openByPointer } from './support/menu'
import { switcher } from './support/workspace'

// Issue #102, ruling 4: a pointer press on an item of a closing menu runs nothing. A middle press
// sends auxclick, not click, and the browser opens a link item in a new tab unless that is stopped.
test('a middle press on a link in the menu right after Escape opens no new tab', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto('/documents')
  const members = page.getByRole('menuitem', { name: 'Members' })
  await openByPointer(switcher(page), members)
  const at = await centreOf(members)
  await page.evaluate(() => {
    window.addEventListener(
      'pointerdown',
      (event) => {
        const onClosingMenu = (event.target as Element).closest('[role="menu"][data-state="closed"]') !== null
        ;(window as unknown as { onClosingMenu: boolean }).onClosingMenu = onClosingMenu
      },
      { capture: true, once: true },
    )
  })

  await page.keyboard.press('Escape')
  await page.mouse.click(at.x, at.y, { button: 'middle' })
  await page.waitForTimeout(2000)

  const onClosingMenu = await page.evaluate(() => (window as unknown as { onClosingMenu: boolean }).onClosingMenu)
  expect(onClosingMenu, 'the press landed on the closing menu').toBe(true)
  expect(context.pages().map((tab) => new URL(tab.url()).pathname)).toEqual(['/documents'])
})
