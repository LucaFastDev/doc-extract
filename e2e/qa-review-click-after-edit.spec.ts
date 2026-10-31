import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, detail, field, invoiceInput, seedDocument } from './support/review'

// QA pass on PR #33: a user who corrects a field and then clicks a button of the review screen
// straight away, without pressing Enter or Tab first, gets that button's action with that one
// click, and the correction is kept (US-5.1 AC-4 to AC-6). On 2033e52 the field's save on blur
// disables every button before the click lands, so the click is lost.

const f = (value: string, confidence = 0.95) => ({ value, confidence })

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('one click on Approve right after editing a field approves the document', async ({ page, context, baseURL }) => {
      const user = await createUser('Eli Edit')
      const id = await seedDocument(user, {
        file: pngFile(`Edit then approve ${name}.png`),
        input: invoiceInput({ due_date: f('2026-11-01'), subtotal: f('100.00') }),
      })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      const approve = page.getByRole('button', { name: 'Approve', exact: true })
      await expect(approve).toBeEnabled()

      await page.getByLabel('Vendor name', { exact: true }).fill('Acme Supplies GmbH')
      await approve.click()

      await expect(detail(page, 'Status')).toHaveText('Approved')
      await expect(page.getByTestId('approval')).toContainText('Approved by Eli Edit')
      await expect(field(page, 'vendor_name')).toContainText('Extracted: Acme Supplies Ltd')
      const [doc] = await sql<{ status: string; corrected_value: string }>(
        "select d.status, f.corrected_value from public.documents d join public.extraction_fields f on f.document_id = d.id and f.path = 'vendor_name' where d.id = $1",
        [id],
      )
      expect(doc).toEqual({ status: 'approved', corrected_value: 'Acme Supplies GmbH' })
    })

    test('one click on Add line right after editing a field adds the line', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Edit then add ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await page.getByLabel('Vendor name', { exact: true }).fill('Acme Supplies GmbH')
      await page.getByRole('button', { name: 'Add line' }).click()

      await expect(page.getByRole('region', { name: 'Line 2' })).toBeVisible()
      await expect(field(page, 'vendor_name')).toContainText('Extracted: Acme Supplies Ltd')
      await expect
        .poll(async () => (await sql<{ n: number }>("select count(*)::int as n from public.extraction_fields where document_id = $1 and path like 'line_items[1]%'", [id]))[0].n)
        .toBeGreaterThan(0)
    })

    test('one click on a tick box right after editing a field ticks the check', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Edit then tick ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await page.getByLabel('Vendor name', { exact: true }).fill('Acme Supplies GmbH')
      const tick = check(page, 'D2').getByRole('checkbox', { name: 'Tick D2' })
      await tick.click()

      await expect(tick).toBeChecked()
      await expect(field(page, 'vendor_name')).toContainText('Extracted: Acme Supplies Ltd')
      await expect.poll(async () => sql('select check_id from public.check_ticks where document_id = $1', [id])).toEqual([{ check_id: 'D2' }])
    })
  })
}
