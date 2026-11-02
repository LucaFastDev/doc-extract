import { expect, type Locator, type Page } from '@playwright/test'

// Pressing a menu during its exit animation (issue #102). The animation lasts about 150 ms from
// Escape, so the press goes by coordinates measured beforehand: a locator's click would wait for the
// animation to end, which is the moment under test.

/** Opens the menu with the pointer. A press before the page is hydrated does nothing. */
export async function openByPointer(button: Locator, item: Locator) {
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
    await expect(item).toBeVisible({ timeout: 1000 })
  }).toPass()
}

/** Where to press the target. The hover waits for the menu's opening animation to end. */
export async function centreOf(target: Locator) {
  await target.hover()
  const box = await target.boundingBox()
  if (!box) throw new Error('the press target is not on the page')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Escape, then a plain left press at once. Returns what the press met, recorded in the page. */
export async function escapeThenPress(page: Page, at: { x: number; y: number }) {
  await page.evaluate(() => {
    const closing = '[role="menu"][data-state="closed"]'
    window.addEventListener(
      'pointerdown',
      (event) => {
        const state = {
          menuClosing: document.querySelector(closing) !== null,
          onClosingMenu: (event.target as Element).closest(closing) !== null,
        }
        ;(window as unknown as { pressMet: typeof state }).pressMet = state
      },
      { capture: true, once: true },
    )
  })
  await page.keyboard.press('Escape')
  await page.mouse.click(at.x, at.y)
  return page.evaluate(() => (window as unknown as { pressMet: { menuClosing: boolean; onClosingMenu: boolean } }).pressMet)
}
