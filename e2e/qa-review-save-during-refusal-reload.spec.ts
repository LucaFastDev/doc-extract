import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { seedDocument } from './support/review'

// QA pass on PR #35: a failed save must not leave an unsaved value looking saved (Lead ruling on QA
// pass 2 of #34). On 58d5eec, on a slow network, a field the user leaves while the screen reloads
// after another field's failed save is dropped with the actions queued behind that failure, but it
// is never put back: it keeps showing what the user typed, with no message naming it, and nothing
// is stored.

/** What the database holds as the field's value: the correction, or else the extracted value. */
async function stored(id: string, path: string) {
  const [row] = await sql<{ value: string | null }>(
    'select coalesce(corrected_value, extracted_value) as value from public.extraction_fields where document_id = $1 and path = $2',
    [id, path],
  )
  return row?.value ?? null
}

for (const { name, viewport } of [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a field left while the screen reloads after a failed save shows what is stored', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Slow network ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      // A slow, flaky network: the vendor name's save fails after a second, and the reload that
      // follows the failure takes a few seconds.
      await page.route('**/rest/v1/extraction_fields*', async (route) => {
        const r = route.request()
        if (r.method() === 'PATCH' && r.url().includes('vendor_name')) {
          await new Promise((done) => setTimeout(done, 1000))
          return route.abort()
        }
        return route.continue()
      })
      await page.route('**/rest/v1/document_events*', async (route) => {
        await new Promise((done) => setTimeout(done, 3000))
        return route.continue()
      })

      await page.getByLabel('Vendor name', { exact: true }).fill('Slow Ltd')
      const number = page.getByLabel('Invoice number', { exact: true })
      await number.click()
      await page.keyboard.type('NEW-1', { delay: 50 })
      await expect(page.getByRole('main').getByRole('alert')).toHaveText('Vendor name could not be saved. Try again.')
      // The user finishes the invoice number while the screen is still reloading.
      await page.keyboard.press('Enter')

      // Either it was saved, or the field shows the stored value again: never an unsaved value.
      await expect
        .poll(async () => (await number.inputValue()) === (await stored(id, 'invoice_number')), { timeout: 10_000 })
        .toBe(true)
    })
  })
}
