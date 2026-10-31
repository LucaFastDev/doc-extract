import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { field, seedDocument } from './support/review'

// QA pass on PR #34: a user who corrects a flagged field and goes straight on to the next flagged
// field, by clicking it or with Tab, keeps the focus there and what they type is saved (US-5.1
// AC-4). On 30066a7 the first field's save clears the flags of the other fields of the same check,
// which then move from "Flagged fields" to "Fields": the field the user is in is mounted again, it
// loses the focus, and what they type is lost without a message.

/** The stored correction of one field, or null. */
async function corrected(id: string, path: string) {
  const [row] = await sql<{ corrected_value: string | null }>(
    'select corrected_value from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return row?.corrected_value ?? null
}

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a click into the next flagged field right after a correction keeps the focus and what is typed there', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Correct then click ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      const flagged = page.getByRole('region', { name: 'Flagged fields' })
      await expect(flagged.locator('[data-field="total"]')).toHaveCount(1)

      // Subtotal 100.00 passes A2 and A3, so Total is no longer flagged once it is saved.
      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      const total = page.getByLabel('Total', { exact: true })
      await total.click()
      await total.pressSequentially('119.50', { delay: 80 })

      await expect(page.getByLabel('Total', { exact: true })).toBeFocused()
      await expect(page.getByLabel('Total', { exact: true })).toHaveValue('119.50')
      await page.keyboard.press('Enter')
      await expect(field(page, 'total')).toContainText('Extracted: 119.00')
      await expect.poll(() => corrected(id, 'total')).toBe('119.50')
      await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
    })

    test('Tab from a correction to the next flagged field keeps the focus there and what is typed is saved', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Correct then tab ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      await page.keyboard.press('Tab')
      const next = await page.evaluate(() => document.activeElement?.closest('[data-field]')?.getAttribute('data-field') ?? null)
      expect(next).not.toBeNull()
      await page.keyboard.type('7.00', { delay: 80 })

      await expect(field(page, next!).getByRole('textbox')).toBeFocused()
      await expect(field(page, next!).getByRole('textbox')).toHaveValue('7.00')
      await page.keyboard.press('Enter')
      await expect.poll(() => corrected(id, next!)).toBe('7.00')
    })
  })
}
