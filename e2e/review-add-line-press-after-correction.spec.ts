import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, field, seedDocument } from './support/review'

// A press on Add line while a correction that changes the checks saves (Lead ruling on QA pass 5
// of PR #37): one click on a button right after a correction runs it, even when the save lands and
// the checks re-run during the press. While the press is held, nothing above the button moves, so
// the release lands on it.

/** The stored correction of one field, or null. */
async function corrected(id: string, path: string) {
  const [row] = await sql<{ corrected_value: string | null }>(
    'select corrected_value from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return row?.corrected_value ?? null
}

/** How many line items are stored. */
async function lines(id: string) {
  const [row] = await sql<{ n: number }>(
    "select count(distinct substring(path from '^line_items\\[(\\d+)\\]'))::int as n from public.extraction_fields where document_id = $1 and path like 'line_items[%'",
    [id],
  )
  return row.n
}

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a press on Add line while a correction that passes A2 and A3 saves adds the line, and the button does not move', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Add line press ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      // Subtotal 100.00 passes A2 and A3: their rows lose their messages and tick boxes, the
      // subtotal loses its reasons and gains its "Extracted:" line, all above Add line.
      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      const add = page.getByRole('button', { name: 'Add line' })
      await add.scrollIntoViewIfNeeded()
      const before = (await add.boundingBox())!
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
      await page.mouse.down()
      await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
      await expect(field(page, 'subtotal')).toContainText('Extracted: 120.00')
      const during = (await add.boundingBox())!
      expect(during.y).toBe(before.y)
      await page.mouse.up()

      await expect(page.getByRole('region', { name: 'Line 2' })).toBeVisible()
      await expect.poll(() => lines(id)).toBe(2)
    })

    test('a press on Add line while a correction that fails A1 saves adds the line, and the button does not move', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Add line press fail ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      // Quantity 5 fails A1: its row, above Add line, gains its message and its tick box.
      await field(page, 'line_items[0].quantity').locator('input').fill('5')
      const add = page.getByRole('button', { name: 'Add line' })
      await add.scrollIntoViewIfNeeded()
      const before = (await add.boundingBox())!
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
      await page.mouse.down()
      await expect.poll(() => corrected(id, 'line_items[0].quantity')).toBe('5')
      await expect(check(page, 'A1')).toHaveAttribute('data-status', 'fail')
      const during = (await add.boundingBox())!
      expect(during.y).toBe(before.y)
      await page.mouse.up()

      await expect(page.getByRole('region', { name: 'Line 2' })).toBeVisible()
      await expect.poll(() => lines(id)).toBe(2)
    })
  })
}
