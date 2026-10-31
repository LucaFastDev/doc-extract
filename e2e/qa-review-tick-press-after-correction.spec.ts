import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, field, seedDocument } from './support/review'

// QA pass on PR #37: a user who corrects a field and then clicks the tick box of a check that still
// fails gets that check ticked with that one click (US-5.1 AC-5; the QA spec on #33 "one click on a
// tick box right after editing a field ticks the check"; ruling 3 on #34 lets a tick go only when
// its check passes once the save lands). On 4ccd095 the correction's save lands while the button is
// down and the checks re-sort inside the held Checks box: Tick D2 moves about 214px up when A2 and
// A3 start passing, or 45 to 97px down when A1 starts failing, so the release misses it, no click
// reaches it and D2 stays unticked. On the local stack an ordinary 100ms click is enough.

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

/** Presses the mouse on the middle of D2's tick box, holds it until `during` resolves, and releases it where the mouse still is. */
async function pressTickD2(page: Page, during: () => Promise<void>) {
  const tick = check(page, 'D2').getByRole('checkbox', { name: 'Tick D2' })
  await tick.scrollIntoViewIfNeeded()
  const box = (await tick.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await during()
  await page.mouse.up()
  return tick
}

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a press on Tick D2 while a correction that passes A2 and A3 saves ticks D2', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Tick after pass ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      const tick = await pressTickD2(page, async () => {
        await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
        await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
      })

      await expect(check(page, 'D2')).toHaveAttribute('data-status', 'fail')
      await expect(tick).toBeChecked()
      await expect.poll(() => ticks(id)).toEqual(['D2'])
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
    })

    test('a press on Tick D2 while a correction that fails A1 saves ticks D2', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Tick after fail ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await field(page, 'line_items[0].quantity').locator('input').fill('5')
      const tick = await pressTickD2(page, async () => {
        await expect.poll(() => corrected(id, 'line_items[0].quantity')).toBe('5')
        await expect(check(page, 'A1')).toHaveAttribute('data-status', 'fail')
      })

      await expect(tick).toBeChecked()
      await expect.poll(() => ticks(id)).toEqual(['D2'])
    })
  })
}
