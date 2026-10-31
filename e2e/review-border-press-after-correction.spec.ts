import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, field, seedDocument } from './support/review'

// The same press as e2e/qa-review-label-press-after-correction.spec.ts, on the next field's border
// or padding instead of its label (Lead ruling on QA pass 4 of PR #36): a press that starts on a
// field's box ends in that field, with the focus in it, even when the correction's save lands and
// the checks re-run during the press. While the press is held, nothing above the field changes its
// height, so the field does not move under the pointer.

/** The stored correction of one field, or null. */
async function corrected(id: string, path: string) {
  const [row] = await sql<{ corrected_value: string | null }>(
    'select corrected_value from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return row?.corrected_value ?? null
}

/** A point in the left padding of a field's box, halfway down: inside its border, outside its label and input. */
async function paddingPoint(page: Page, path: string) {
  const box = field(page, path)
  await box.scrollIntoViewIfNeeded()
  const b = (await box.boundingBox())!
  return { x: b.x + 6, y: b.y + b.height / 2 }
}

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a press on the next field border while the correction saves moves into that field, which does not move, and keeps what is typed', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Border press ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      // Subtotal 100.00 passes A2 and A3, which shrinks the Checks section once the save lands.
      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      const point = await paddingPoint(page, 'due_date')
      const before = (await field(page, 'due_date').boundingBox())!
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
      const during = (await field(page, 'due_date').boundingBox())!
      expect(during.y).toBe(before.y)
      await page.mouse.up()

      const due = page.getByLabel('Due date', { exact: true })
      await expect(due).toBeFocused()
      await page.keyboard.type('2026-10-31', { delay: 50 })
      await expect(due).toBeFocused()
      await expect(due).toHaveValue('2026-10-31')
      await page.keyboard.press('Enter')
      await expect.poll(() => corrected(id, 'due_date')).toBe('2026-10-31')
    })

    test.describe('by touch', () => {
      test.use({ hasTouch: true })

      test('a tap on the next field border after a correction moves into that field and keeps what is typed', async ({ page, context, baseURL }) => {
        const user = await createUser()
        const id = await seedDocument(user, { file: pngFile(`Border tap ${name}.png`) })
        await signIn(context, baseURL!, user)
        await page.goto(`/documents/${id}`)

        await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
        const point = await paddingPoint(page, 'due_date')
        await page.touchscreen.tap(point.x, point.y)

        const due = page.getByLabel('Due date', { exact: true })
        await expect(due).toBeFocused()
        await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
        await page.keyboard.type('2026-10-31', { delay: 50 })
        await expect(due).toBeFocused()
        await expect(due).toHaveValue('2026-10-31')
        await page.keyboard.press('Enter')
        await expect.poll(() => corrected(id, 'due_date')).toBe('2026-10-31')
      })
    })
  })
}
