import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { detail, field, seedDocument } from './support/review'

// A correction that is not saved says why (Lead ruling on QA pass 2 of #34): "the document no
// longer needs review" only when that is the reason, and "<Field> could not be saved. Try again."
// for any other failure, such as a network error. The actions queued behind it are dropped, and the
// field shows the stored value again, so the unsaved one does not look saved.

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

    test('a correction lost on the network asks to try again, drops the queued action and shows the stored value', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Network failure ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      await page.route('**/rest/v1/extraction_fields*', (route) => (route.request().method() === 'PATCH' ? route.abort() : route.continue()))

      await page.getByLabel('Vendor name', { exact: true }).fill('Net Ltd')
      await page.getByRole('button', { name: 'Add line' }).click()

      await expect(page.getByRole('main').getByRole('alert')).toHaveText('Vendor name could not be saved. Try again.')
      await expect(page.getByLabel('Vendor name', { exact: true })).toHaveValue('Acme Supplies Ltd')
      await expect(field(page, 'vendor_name')).not.toContainText('Extracted:')
      await expect(page.getByRole('region', { name: 'Line 2' })).toHaveCount(0)
      await expect(detail(page, 'Status')).toHaveText('Needs review')
      expect(await corrected(id, 'vendor_name')).toBeNull()
      expect(await sql("select 1 from public.extraction_fields where document_id = $1 and path like 'line_items[1]%'", [id])).toEqual([])
    })

    test('a correction to a document that no longer needs review says so', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Approved elsewhere ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      // Another member approves it while this screen is open.
      await sql("update public.documents set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, user.id])

      await page.getByLabel('Vendor name', { exact: true }).fill('Late Ltd')
      await page.getByLabel('Vendor name', { exact: true }).press('Enter')

      await expect(page.getByRole('main').getByRole('alert')).toHaveText('Vendor name could not be saved: the document no longer needs review.')
      await expect(detail(page, 'Status')).toHaveText('Approved')
      expect(await corrected(id, 'vendor_name')).toBeNull()
    })
  })
}
