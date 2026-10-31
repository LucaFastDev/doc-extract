import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, field, seedDocument } from './support/review'

// QA pass on PR #36: a press on a field's label counts as moving between fields (Lead ruling (a) on
// #36), so the user who corrects a field and then presses the next field's label lands in that
// field, and what they type there is kept and saved (US-5.1 AC-4; ruling 1 on QA pass 3 of #35).
// On 413769e, the correction's save lands while the mouse button is down: the checks above the
// fields re-run and the page shifts by about 90px under the pointer, so the release is no longer
// on the label, no click reaches it, and the focus is left on <body>. On the local stack an
// ordinary 80ms press is enough.

/** The stored correction of one field, or null. */
async function corrected(id: string, path: string) {
  const [row] = await sql<{ corrected_value: string | null }>(
    'select corrected_value from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return row?.corrected_value ?? null
}

/** Presses the mouse on the middle of the label, holds it until `during` resolves, and releases it where the mouse still is. */
async function pressLabel(page: Page, path: string, during: () => Promise<void>) {
  const label = field(page, path).locator('label')
  await label.scrollIntoViewIfNeeded()
  const box = (await label.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await during()
  await page.mouse.up()
}

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a press on the next field label while the correction saves moves into that field and keeps what is typed', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Label press ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      // Subtotal 100.00 passes A2 and A3. The user presses the Due date label, and the save lands
      // and the checks re-run before they release the button.
      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      await pressLabel(page, 'due_date', async () => {
        await expect.poll(() => corrected(id, 'subtotal')).toBe('100.00')
        await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
      })

      const due = page.getByLabel('Due date', { exact: true })
      await expect(due).toBeFocused()
      await page.keyboard.type('2026-10-31', { delay: 50 })
      await expect(due).toBeFocused()
      await expect(due).toHaveValue('2026-10-31')
      await page.keyboard.press('Enter')
      await expect.poll(() => corrected(id, 'due_date')).toBe('2026-10-31')
    })
  })
}
