import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, seedDocument } from './support/review'

// QA pass on PR #35: after a correction has been saved, a user who passes through the next flagged
// field without changing it (it looks right) and goes on to the one after it, by click or Tab,
// keeps the focus there and what they type is saved (US-5.1 AC-4; Lead ruling 2 on #35: a field
// stays in its section until the user leaves the fields). On 58d5eec, leaving the untouched field
// runs its no-change save at once, which ends the queue while the focus is between the two fields;
// the sections then follow the live flags, the field the user goes into moves from "Flagged
// fields" to "Fields", is mounted again, and loses the focus and what they type.

/** The stored correction of one field, or null. */
async function corrected(id: string, path: string) {
  const [row] = await sql<{ corrected_value: string | null }>(
    'select corrected_value from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return row?.corrected_value ?? null
}

/** The path of the field the focus is in, or null. */
const focusedField = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest('[data-field]')?.getAttribute('data-field') ?? null)

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a click from an untouched flagged field into the next one, after a saved correction, keeps the focus and what is typed', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Untouched then click ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      // Subtotal 100.00 passes A2 and A3; the user goes into Total and the save lands.
      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      await page.getByLabel('Total', { exact: true }).click()
      await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
      await expect(page.getByLabel('Total', { exact: true })).toBeFocused()

      // Total looks right; the user goes on to Tax total without changing it, and types.
      const tax = page.getByLabel('Tax total', { exact: true })
      await tax.click()
      // Typed as a user does, into whatever has the focus after the click.
      await page.keyboard.type('7.00', { delay: 80 })

      await expect(page.getByLabel('Tax total', { exact: true })).toBeFocused()
      await expect(page.getByLabel('Tax total', { exact: true })).toHaveValue('7.00')
      await page.keyboard.press('Enter')
      await expect.poll(() => corrected(id, 'tax_total')).toBe('7.00')
      expect(await corrected(id, 'total')).toBeNull()
    })

    test('Tab from an untouched flagged field to the next one, after a saved correction, keeps the focus and what is typed', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Untouched then tab ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      await page.keyboard.press('Tab')
      const first = await focusedField(page)
      expect(first).not.toBeNull()
      await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')

      // The field Tab reached looks right; Tab on to the next and type there.
      await page.keyboard.press('Tab')
      const next = await focusedField(page)
      expect(next).not.toBeNull()
      await page.keyboard.type('7.00', { delay: 80 })

      expect(await focusedField(page)).toBe(next)
      await expect(page.locator(`[data-field="${next}"]`).getByRole('textbox')).toHaveValue('7.00')
      await page.keyboard.press('Enter')
      await expect.poll(() => corrected(id, next!)).toBe('7.00')
      expect(await corrected(id, first!)).toBeNull()
    })
  })
}
