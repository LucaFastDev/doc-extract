import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { pdfFile, pngFile } from './support/files'
import { check, detail, expectNoSideScroll, field, seedDocument } from './support/review'

// The review screen (milestone 7, PRD F5, US-4.1 AC-7, F14, F19; OQ-11, OQ-12, OQ-40, OQ-44), at
// phone width and on a desktop. Documents are stored as process-queue leaves them
// (e2e/support/review.ts); approve-document, the review RPCs and DELETE /api/documents/[id] run
// for real against the local stack. The type change, which needs the pipeline, is in
// extraction.spec.ts.

const VIEWPORTS = [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]

/** Counts page loads from now on, so a spec can show a change came without a reload. */
function countLoads(page: Page) {
  const loads = { count: 0 }
  page.on('load', () => loads.count++)
  return loads
}

for (const { name, viewport } of VIEWPORTS) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a member opens a Needs review invoice, corrects it so a check passes live, ticks the other, approves, and reopens it', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser('Riley Reviewer')
      const file = pngFile(`Invoice to review ${name}.png`)
      const id = await seedDocument(user, { file })
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      // Opened from the list (US-5.1 AC-1).
      await page.getByRole('link', { name: file.name }).click()
      await expect(page).toHaveURL(new RegExp(`/documents/${id}$`))
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(file.name)
      await expect(detail(page, 'Type')).toHaveText('Invoice')
      await expect(detail(page, 'Status')).toHaveText('Needs review')
      // The file, through a short-lived signed URL (ARCHITECTURE.md section 5).
      await expect(page.getByRole('img', { name: file.name })).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/documents\//)
      const loads = countLoads(page)

      // Flagged first, each with its reason and confidence (US-5.1 AC-2, AC-3, US-4.1).
      const flagged = page.getByRole('region', { name: 'Flagged fields' })
      await expect(flagged.locator('[data-field="subtotal"]')).toBeVisible()
      await expect(page.getByRole('region', { name: 'Fields', exact: true }).locator('[data-field="subtotal"]')).toHaveCount(0)
      // D2's dates, A2's and A3's amounts, and nothing else, come before the rest on the page.
      const paths = (scope: Page | ReturnType<Page['locator']>) =>
        scope.locator('[data-field]').evaluateAll((els) => els.map((e) => e.getAttribute('data-field')))
      const flaggedPaths = await paths(flagged)
      expect([...flaggedPaths].sort()).toEqual(
        ['discount_total', 'due_date', 'invoice_date', 'line_items[0].amount', 'shipping', 'subtotal', 'tax_total', 'total'].sort(),
      )
      expect((await paths(page)).slice(0, flaggedPaths.length)).toEqual(flaggedPaths)
      await expect(field(page, 'subtotal')).toContainText('A2: Line items sum to 100.00; subtotal is 120.00')
      await expect(field(page, 'subtotal')).toContainText('Low confidence (55%)')
      await expect(field(page, 'subtotal')).toContainText('Confidence 55%')
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'fail')
      await expect(check(page, 'A2')).toContainText('Line items sum to 100.00; subtotal is 120.00')
      await expect(check(page, 'D2')).toContainText('Due date 2026-09-01 is before invoice date 2026-10-01')
      const approve = page.getByRole('button', { name: 'Approve', exact: true })
      await expect(approve).toBeDisabled()

      // A correction re-runs the checks in the browser (US-4.1 AC-7) and keeps the original (US-5.1 AC-4).
      await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
      await page.getByLabel('Subtotal', { exact: true }).press('Enter')
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
      await expect(check(page, 'A3')).toHaveAttribute('data-status', 'pass')
      await expect(field(page, 'subtotal')).toContainText('Extracted: 120.00')
      await expect(field(page, 'subtotal')).not.toContainText('A2:')
      await expect(approve).toBeDisabled()
      const [saved] = await sql<{ corrected_value: string; extracted_value: string }>(
        "select corrected_value, extracted_value from public.extraction_fields where document_id = $1 and path = 'subtotal'",
        [id],
      )
      expect(saved).toEqual({ corrected_value: '100.00', extracted_value: '120.00' })

      // The remaining failed check is ticked; low confidence does not block (US-5.1 AC-5, OQ-11).
      await check(page, 'D2').getByRole('checkbox', { name: 'Tick D2' }).click()
      await expect(check(page, 'D2').getByRole('checkbox', { name: 'Tick D2' })).toBeChecked()
      await expect(approve).toBeEnabled()
      await approve.click()

      // Approved, with who and when (US-5.1 AC-6).
      await expect(page.getByTestId('approval')).toContainText(/Approved by Riley Reviewer on \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC/)
      await expect(detail(page, 'Status')).toHaveText('Approved')
      expect(loads.count).toBe(0)
      await expectNoSideScroll(page)
      const [approved] = await sql<{ status: string; approved_by: string }>('select status, approved_by from public.documents where id = $1', [id])
      expect(approved).toEqual({ status: 'approved', approved_by: user.id })

      // Corrections survive a reload; an approved document is no longer edited.
      await page.reload()
      await expect(field(page, 'subtotal')).toContainText('100.00')
      await expect(field(page, 'subtotal')).toContainText('Extracted: 120.00')
      await expect(page.getByRole('textbox')).toHaveCount(0)

      // Any member reopens it; the reopen is in the history beside the approval, newest first (US-5.1 AC-7).
      await page.getByRole('button', { name: 'Reopen' }).click()
      await expect(detail(page, 'Status')).toHaveText('Needs review')
      await expect(page.getByTestId('approval')).toHaveCount(0)
      const history = page.getByRole('region', { name: 'History' }).getByRole('listitem')
      await expect(history).toHaveText([
        /^Reopened by Riley Reviewer · .* UTC$/,
        /^Approved by Riley Reviewer · .* UTC$/,
        /^Extracted by Claude · .* UTC$/,
        /^Uploaded by Riley Reviewer · .* UTC$/,
      ])
      await expect(page.getByLabel('Subtotal', { exact: true })).toHaveValue('100.00')
      await expectNoSideScroll(page)
    })

    test('a line item is added, filled in and deleted, and the checks follow', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Lines ${name}.png`) })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      const loads = countLoads(page)

      await page.getByRole('button', { name: 'Add line' }).click()
      const line2 = page.getByRole('region', { name: 'Line 2' })
      await expect(line2).toBeVisible()
      // A2 sums every line: skipped while the new line has no amount.
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'skipped')
      await page.getByLabel('Line 2 · Amount').fill('20.00')
      await page.getByLabel('Line 2 · Amount').press('Enter')
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')

      await page.reload()
      await expect(page.getByLabel('Line 2 · Amount')).toHaveValue('20.00')
      await page.getByRole('button', { name: 'Delete line 2' }).click()
      await expect(page.getByRole('region', { name: 'Line 2' })).toHaveCount(0)
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'fail')
      expect(loads.count).toBe(1)
      const lines = await sql<{ n: number }>("select count(*)::int as n from public.extraction_fields where document_id = $1 and path like 'line_items[1]%'", [id])
      expect(lines).toEqual([{ n: 0 }])
      await expectNoSideScroll(page)
    })

    test('a document is deleted from the list after a confirmation that names it, and its review URL then says it does not exist', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser()
      const file = pngFile(`Unwanted ${name}.png`)
      const id = await seedDocument(user, { file })
      await signIn(context, baseURL!, user)
      await page.goto('/documents')
      const row = page.getByRole('row').filter({ hasText: file.name })

      // Cancel changes nothing (US-19.1 AC-2).
      await row.getByRole('button', { name: `Delete ${file.name}` }).click()
      const confirm = page.getByRole('dialog', { name: `Delete ${file.name}?` })
      await expect(confirm).toContainText('Pages it used are not given back.')
      await expectNoSideScroll(page)
      await confirm.getByRole('button', { name: 'Cancel' }).click()
      await expect(confirm).toBeHidden()
      await expect(row).toBeVisible()
      expect(await sql('select 1 from public.documents where id = $1', [id])).toHaveLength(1)

      // Confirm deletes it, its file and its results (AC-3).
      await row.getByRole('button', { name: `Delete ${file.name}` }).click()
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(confirm).toBeHidden()
      await expect(row).toHaveCount(0)
      expect(await sql('select 1 from public.documents where id = $1', [id])).toEqual([])
      expect(await sql('select 1 from public.extraction_fields where document_id = $1', [id])).toEqual([])
      expect(await sql("select 1 from storage.objects where bucket_id = 'documents' and name like $1", [`%/${id}/original`])).toEqual([])

      await page.goto(`/documents/${id}`)
      await expect(page.getByRole('heading', { name: 'This document does not exist' })).toBeVisible()
      await expectNoSideScroll(page)
    })

    test('a document is deleted from its review screen', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const file = pngFile(`Delete from review ${name}.png`)
      const id = await seedDocument(user, { file })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await page.getByRole('main').getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('dialog', { name: `Delete ${file.name}?` }).getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(page).toHaveURL(/\/documents$/)
      await expect(page.getByRole('row').filter({ hasText: file.name })).toHaveCount(0)
      expect(await sql('select 1 from public.documents where id = $1', [id])).toEqual([])
    })

    test('every page of a two-page PDF is shown, and the zoom control zooms in and out', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const file = await pdfFile(`Two pages ${name}.pdf`, 2)
      const id = await seedDocument(user, { file })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      const pages = page.getByRole('region', { name: 'Document', exact: true }).getByRole('img')
      await expect(pages).toHaveCount(2)
      await expect(pages.nth(0)).toHaveAccessibleName(`${file.name}, page 1 of 2`)
      await expect(pages.nth(1)).toHaveAccessibleName(`${file.name}, page 2 of 2`)
      const zoom = page.getByRole('status', { name: 'Zoom level' })
      await expect(zoom).toHaveText('100%')
      const fit = (await pages.nth(0).boundingBox())!.width

      await page.getByRole('button', { name: 'Zoom in' }).click()
      await expect(zoom).toHaveText('125%')
      await expect.poll(async () => (await pages.nth(0).boundingBox())!.width).toBeGreaterThan(fit * 1.2)
      await page.getByRole('button', { name: 'Zoom out' }).click()
      await page.getByRole('button', { name: 'Zoom out' }).click()
      await expect(zoom).toHaveText('75%')
      await expect.poll(async () => (await pages.nth(0).boundingBox())!.width).toBeLessThan(fit * 0.8)
      // Zoomed in, the frame scrolls; the page does not.
      for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Zoom in' }).click()
      await expect(zoom).toHaveText('300%')
      await expectNoSideScroll(page)
    })

    test('after the file is deleted, the fields and checks are still shown, with no viewer and no type change', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser()
      const id = await seedDocument(user, { file: pngFile(`Old ${name}.png`), fileDeleted: true })
      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)

      await expect(page.getByText('The file was deleted 7 days after upload')).toBeVisible()
      await expect(page.getByRole('region', { name: 'Document', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Change type' })).toHaveCount(0)
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'fail')
      await expect(page.getByLabel('Subtotal', { exact: true })).toHaveValue('120.00')
      await expectNoSideScroll(page)
    })
  })
}

test('a non-member, and a document that does not exist, get a page that says so and no data', async ({ page, context, baseURL }) => {
  const owner = await createUser()
  const file = pngFile('Private invoice.png')
  const id = await seedDocument(owner, { file })
  const stranger = await createUser()
  await signIn(context, baseURL!, stranger)

  for (const path of [`/documents/${id}`, '/documents/00000000-0000-4000-8000-000000000000', '/documents/not-an-id']) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'This document does not exist' })).toBeVisible()
    await expect(page.getByText(file.name)).toHaveCount(0)
  }
  // Nor can they delete it (US-19.1 AC-6).
  const deleted = await page.request.delete(`/api/documents/${id}`)
  expect(deleted.status()).toBe(404)
  expect(await sql('select 1 from public.documents where id = $1', [id])).toHaveLength(1)
})

test('a document still in the pipeline is not opened for review (Lead ruling 3 on #32)', async ({ page, context, baseURL }) => {
  const user = await createUser()
  const id = await seedDocument(user, { file: pngFile('Still queued.png') })
  await sql("update public.documents set status = 'queued' where id = $1", [id])
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await expect(page.getByRole('row').filter({ hasText: 'Still queued.png' }).getByRole('link')).toHaveCount(0)

  await page.goto(`/documents/${id}`)
  await expect(page.getByRole('main')).toContainText('It is queued, so there is nothing to review yet.')
  await expect(page.getByRole('region', { name: 'Checks' })).toHaveCount(0)
})

test('a Not supported document opens a screen that offers the type change', async ({ page, context, baseURL }) => {
  const user = await createUser()
  const file = pngFile('Letter.png')
  const id = await seedDocument(user, { file, status: 'unsupported', statusReason: 'Not a supported document type: This is a letter.' })
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await page.getByRole('link', { name: file.name }).click()
  await expect(page).toHaveURL(new RegExp(`/documents/${id}$`))
  await expect(page.getByRole('main')).toContainText('Not a supported document type: This is a letter.')
  await expect(page.getByRole('region', { name: 'Checks' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Change type' }).click()
  const dialog = page.getByRole('dialog', { name: `Change the type of ${file.name}` })
  await expect(dialog.getByRole('radio')).toHaveCount(6)
  await expect(dialog.getByRole('button', { name: 'Change type and extract again' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})
