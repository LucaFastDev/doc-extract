import { readFile } from 'node:fs/promises'
import { expect, test, type Download, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { createUser, signIn, sql } from './support/auth'
import { pngFile } from './support/files'
import { check, expectNoSideScroll, seedDocument } from './support/review'
import { personalWorkspace, useWorkspace } from './support/workspace'
import { readXlsx } from './support/xlsx'

// Export (milestone 8, PRD US-6.1, OQ-13; issue #39 criteria 2, 11 and 12), at phone width and on
// a desktop. Invoices are stored as process-queue leaves them (e2e/support/review.ts) and approved
// on the review screen, through approve-document, as a member does it. Each download is read here.

const VIEWPORTS = [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]

/** Corrects the subtotal from 120.00 to 100.00, which passes A2 and A3, ticks D2 and approves. */
async function approveOnReviewScreen(page: Page, id: string) {
  await page.goto(`/documents/${id}`)
  await page.getByLabel('Subtotal', { exact: true }).fill('100.00')
  await page.getByLabel('Subtotal', { exact: true }).press('Enter')
  await expect(check(page, 'A2')).toHaveAttribute('data-status', 'pass')
  await check(page, 'D2').getByRole('checkbox', { name: 'Tick D2' }).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('approval')).toBeVisible()
}

async function bytesOf(download: Download): Promise<Uint8Array> {
  return new Uint8Array(await readFile(await download.path()))
}

/** A CSV file's rows, split on commas: the values these specs check hold none. */
const csvRows = (bytes: Uint8Array) =>
  strFromU8(bytes)
    .split('\r\n')
    .filter(Boolean)
    .map((r) => r.split(','))

/** The values of a column of rows whose first row is the header. */
const columnOf = (rows: (string | null)[][], name: string) => rows.slice(1).map((r) => r[rows[0].indexOf(name)])

const today = () => new Date().toISOString().slice(0, 10)

for (const { name, viewport } of VIEWPORTS) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a member approves two invoices, exports one of them as XLSX and as CSV, and the files hold its corrected values', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser('Erin Exporter')
      const kept = pngFile(`Kept invoice ${name}.png`)
      const dropped = pngFile(`Dropped invoice ${name}.png`)
      const pending = pngFile(`Pending invoice ${name}.png`)
      const keptId = await seedDocument(user, { file: kept })
      const droppedId = await seedDocument(user, { file: dropped })
      await seedDocument(user, { file: pending })
      await signIn(context, baseURL!, user)
      await approveOnReviewScreen(page, keptId)
      await approveOnReviewScreen(page, droppedId)

      // Export opens from the document list.
      await page.goto('/documents')
      await page.getByRole('link', { name: 'Export', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/export$/)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Export')

      // A type with no approved documents cannot be picked; Invoice shows its two (US-6.1 AC-3).
      await expect(page.getByRole('radio', { name: /^Receipt\b/ })).toBeDisabled()
      await expect(page.getByRole('radio', { name: /^Bank statement\b/ })).toBeDisabled()
      const invoice = page.getByRole('radio', { name: /^Invoice\b/ })
      await expect(invoice).toBeEnabled()
      await expect(invoice).toHaveAccessibleName(/2 approved/)
      await invoice.click()

      // The approved invoices only, all ticked at first (AC-1, AC-3).
      const documents = page.getByRole('region', { name: 'Documents' })
      await expect(documents.getByRole('checkbox')).toHaveCount(2)
      await expect(documents.getByRole('checkbox', { name: kept.name })).toBeChecked()
      await expect(documents.getByRole('checkbox', { name: dropped.name })).toBeChecked()
      await expect(page.getByText(pending.name)).toHaveCount(0)

      // Download is disabled while nothing is ticked.
      const download = page.getByRole('button', { name: 'Download' })
      await page.getByRole('button', { name: 'Select none' }).click()
      await expect(documents.getByRole('checkbox', { name: kept.name })).not.toBeChecked()
      await expect(download).toBeDisabled()
      await page.getByRole('button', { name: 'Select all' }).click()
      await expect(download).toBeEnabled()
      await documents.getByRole('checkbox', { name: dropped.name }).click()
      await expect(documents.getByRole('checkbox', { name: dropped.name })).not.toBeChecked()
      await expectNoSideScroll(page)

      // XLSX: the ticked invoice only, its subtotal as corrected, a number.
      await page.getByRole('radio', { name: /^XLSX\b/ }).click()
      const [xlsx] = await Promise.all([page.waitForEvent('download'), download.click()])
      expect(xlsx.suggestedFilename()).toBe(`invoice-export-${today()}.xlsx`)
      const sheets = readXlsx(await bytesOf(xlsx))
      expect(Object.keys(sheets)).toEqual(['Documents', 'Line items'])
      expect(columnOf(sheets.Documents, 'document_id')).toEqual([keptId])
      expect(columnOf(sheets.Documents, 'file_name')).toEqual([kept.name])
      expect(columnOf(sheets.Documents, 'subtotal')).toEqual(['100'])
      expect(columnOf(sheets.Documents, 'vendor_name')).toEqual(['Acme Supplies Ltd'])
      expect(columnOf(sheets['Line items'], 'document_id')).toEqual([keptId])
      expect(columnOf(sheets['Line items'], 'amount')).toEqual(['100'])

      // CSV: a zip of the two files, the same rows.
      await page.getByRole('radio', { name: /^CSV\b/ }).click()
      const [zip] = await Promise.all([page.waitForEvent('download'), download.click()])
      expect(zip.suggestedFilename()).toBe(`invoice-export-${today()}.zip`)
      const files = unzipSync(await bytesOf(zip))
      expect(Object.keys(files).sort()).toEqual(['documents.csv', 'line_items.csv'])
      const docRows = csvRows(files['documents.csv'])
      expect(columnOf(docRows, 'document_id')).toEqual([keptId])
      expect(columnOf(docRows, 'file_name')).toEqual([kept.name])
      expect(columnOf(docRows, 'subtotal')).toEqual(['100.00'])
      expect(columnOf(docRows, 'approved_at')[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      const lineRows = csvRows(files['line_items.csv'])
      expect(columnOf(lineRows, 'document_id')).toEqual([keptId])
      expect(columnOf(lineRows, 'position')).toEqual(['1'])
      expect(columnOf(lineRows, 'amount')).toEqual(['100.00'])
      await expectNoSideScroll(page)
    })
  })
}

test('a document whose file was deleted after 7 days is still listed and exported', async ({ page, context, baseURL }) => {
  const user = await createUser()
  const old = pngFile('Old approved invoice.png')
  const id = await seedDocument(user, { file: old, status: 'approved', fileDeleted: true })
  await signIn(context, baseURL!, user)
  await page.goto('/documents/export')
  await page.getByRole('radio', { name: /^Invoice\b/ }).click()
  await expect(page.getByRole('region', { name: 'Documents' }).getByRole('checkbox', { name: old.name })).toBeChecked()
  await page.getByRole('radio', { name: /^CSV\b/ }).click()
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()])
  const rows = csvRows(unzipSync(await bytesOf(zip))['documents.csv'])
  expect(columnOf(rows, 'document_id')).toEqual([id])
  // Stored as extracted: nobody corrected it.
  expect(columnOf(rows, 'subtotal')).toEqual(['120.00'])
})

test('a member of one workspace sees none of another workspace’s approved documents on the export page', async ({
  page,
  context,
  baseURL,
}) => {
  const other = await createUser('Other Owner')
  const theirs = pngFile('Their approved invoice.png')
  await seedDocument(other, { file: theirs, status: 'approved' })
  const theirWorkspace = await personalWorkspace(other, 'Other workspace')
  expect(await sql("select 1 from public.documents where workspace_id = $1 and status = 'approved'", [theirWorkspace])).toHaveLength(1)

  const member = await createUser('Mo Member')
  await signIn(context, baseURL!, member)
  // Even with the workspace cookie set to theirs, which is never trusted for access.
  await useWorkspace(context, baseURL!, theirWorkspace)
  await page.goto('/documents/export')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Export')
  for (const type of ['Invoice', 'Receipt', 'Bank statement', 'Purchase order', 'Delivery note', 'Quote']) {
    await expect(page.getByRole('radio', { name: new RegExp(`^${type}\\b`) })).toBeDisabled()
  }
  await expect(page.getByRole('radio', { name: /^Invoice\b/ })).toHaveAccessibleName(/0 approved/)
  await expect(page.getByText(theirs.name)).toHaveCount(0)
})
