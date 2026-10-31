import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, seedDocument } from './support/review'

// Beside e2e/qa-review-tick-press-after-correction.spec.ts (Lead ruling on QA pass 5 of PR #37):
// while the sections are held, nothing above a tick box moves it under a press. A check row above
// it that grows, because its message gets longer, scrolls the page by as much; an error that clears
// when the next change starts keeps its place, blank, until the hold releases.

async function ticks(id: string) {
  return (await sql<{ check_id: string }>('select check_id from public.check_ticks where document_id = $1', [id])).map((r) => r.check_id)
}

async function corrected(id: string, path: string) {
  const [row] = await sql<{ corrected_value: string | null }>(
    'select corrected_value from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return row?.corrected_value ?? null
}

/** Presses the middle of D2's tick box until `during` resolves, checks it is where it was, and releases it. */
async function pressTickD2(page: Page, during: () => Promise<void>) {
  const tick = check(page, 'D2').getByRole('checkbox', { name: 'Tick D2' })
  await tick.scrollIntoViewIfNeeded()
  const before = (await tick.boundingBox())!
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await during()
  const after = (await tick.boundingBox())!
  expect(Math.round(after.y)).toBe(Math.round(before.y))
  await page.mouse.up()
  return tick
}

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a press on Tick D2 while a correction that lengthens the A2 and A3 messages saves ticks D2', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Tick after longer ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      const a3 = check(page, 'A3')
      const a3Before = (await a3.boundingBox())!

      const long = '123456789012345678901234567890.00'
      await page.getByLabel('Subtotal', { exact: true }).fill(long)
      const tick = await pressTickD2(page, async () => {
        await expect.poll(() => corrected(id, 'subtotal')).toBe(long)
        await expect(a3).toContainText('123,456,789,012,345,678,901,234,567,890.00')
      })
      // The rows above D2 really grew.
      expect((await a3.boundingBox())!.height).toBeGreaterThan(a3Before.height)

      await expect(tick).toBeChecked()
      await expect.poll(() => ticks(id)).toEqual(['D2'])
    })

    test('after a refused correction, a press on Tick D2 while the next correction saves ticks D2', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Tick after refusal ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      const patch = '**/rest/v1/extraction_fields*'
      await page.route(patch, (route) => (route.request().method() === 'PATCH' ? route.abort() : route.continue()))
      await page.getByLabel('Vendor name', { exact: true }).fill('Net Ltd')
      await page.getByLabel('Vendor name', { exact: true }).press('Enter')
      const alert = page.getByRole('main').getByRole('alert')
      await expect(alert).toHaveText('Vendor name could not be saved. Try again.')
      await page.unroute(patch)

      // The next change clears the message when it starts, during the press. From the top of the
      // page, where the page cannot scroll up by the message's height.
      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      await page.evaluate(() => window.scrollTo(0, 0))
      const tick = await pressTickD2(page, async () => {
        await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
        await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
        await expect(alert).toBeHidden()
      })

      await expect(tick).toBeChecked()
      await expect.poll(() => ticks(id)).toEqual(['D2'])
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
    })
  })
}
