import { readFile } from 'node:fs/promises'
import { expect, test, type Download, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { createUser, signIn, sql } from './support/auth'
import { check, detail, expectNoSideScroll, field } from './support/review'

// The public demo (milestone 11, PRD F13, OQ-25, OQ-38; issue #41 criteria 5 to 9 and 11), at
// phone width and on a desktop. The samples' rows come from their migration and their files from
// the e2e setup (demo/upload.ts). Every spec watches the browser's requests: no demo page may
// reach an Edge Function or a route handler, so the demo can never call Claude.

const VIEWPORTS = [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]

const SAMPLES = [
  { slug: 'invoice-total-mismatch', title: 'Invoice with a wrong total', file: 'invoice-total-mismatch.pdf', pages: 1 },
  { slug: 'invoice-duplicate', title: 'The same invoice, sent again', file: 'invoice-duplicate.pdf', pages: 1 },
  { slug: 'receipt-photo', title: 'Photographed café receipt', file: 'receipt-photo.png', pages: 1 },
  { slug: 'bank-statement', title: 'Two-page bank statement', file: 'bank-statement.pdf', pages: 2 },
  { slug: 'purchase-order', title: 'Purchase order for office furniture', file: 'purchase-order.pdf', pages: 1 },
  { slug: 'delivery-note', title: 'Delivery note for that order', file: 'delivery-note.pdf', pages: 1 },
  { slug: 'quote-date-error', title: 'Quote with a date error', file: 'quote-date-error.pdf', pages: 1 },
]

/** Every request the page makes to an Edge Function or a route handler, from now on. */
function serverCalls(page: Page): string[] {
  const calls: string[] = []
  page.on('request', (r) => {
    const { pathname } = new URL(r.url())
    if (pathname.includes('/functions/v1/') || pathname.startsWith('/api/')) calls.push(`${r.method()} ${r.url()}`)
  })
  return calls
}

/** The AI spend as the database holds it: every row of the three spend tables. */
async function spendRows() {
  return {
    periods: await sql('select * from public.ai_spend_periods order by period_start'),
    days: await sql('select * from public.ai_spend_days order by day'),
    reservations: await sql('select * from public.ai_spend_reservations order by id'),
  }
}

async function sampleId(slug: string): Promise<string> {
  const [row] = await sql<{ id: string }>('select id from public.demo_documents where slug = $1', [slug])
  return row.id
}

async function bytesOf(download: Download): Promise<Uint8Array> {
  return new Uint8Array(await readFile(await download.path()))
}

/** A CSV file's rows (RFC 4180): the samples' addresses hold commas, so quoted fields are read whole. */
function csvRows(bytes: Uint8Array): string[][] {
  const rows: string[][] = []
  const fields = /("(?:[^"]|"")*"|[^,\r\n]*)(,|\r\n|$)/gy
  let row: string[] = []
  for (const m of strFromU8(bytes).matchAll(fields)) {
    if (m[0] === '') break
    row.push(m[1].startsWith('"') ? m[1].slice(1, -1).replaceAll('""', '"') : m[1])
    if (m[2] !== ',') {
      rows.push(row)
      row = []
    }
  }
  return rows
}

const columnOf = (rows: string[][], name: string) => rows.slice(1).map((r) => r[rows[0].indexOf(name)])

const today = () => new Date().toISOString().slice(0, 10)

/** Each page of the document as the viewer draws it: one canvas per PDF page, or the image. */
const pages = (page: Page, file: string) => page.getByRole('region', { name: 'Document' }).getByRole('img', { name: new RegExp(`^${file.replace('.', '\\.')}`) })

for (const { name, viewport } of VIEWPORTS) {
  test.describe(name, () => {
    test.use({ viewport })

    test('a signed-out visitor opens the wrong-total invoice, corrects it so its check passes, exports it as CSV, and a reload brings the stored result back', async ({
      page,
    }) => {
      const calls = serverCalls(page)

      // /demo, signed out, with no redirect: the published samples in order, and sign-in for one's own (F13 AC-6).
      await page.goto('/demo')
      await expect(page).toHaveURL(/\/demo$/)
      const list = page.getByRole('main').getByRole('listitem')
      await expect(list).toHaveCount(SAMPLES.length)
      for (const [i, s] of SAMPLES.entries()) await expect(list.nth(i).getByRole('link')).toContainText(s.title)
      await expect(list.first()).toContainText('Invoice · 1 page')
      await expect(list.first()).toContainText('A failed total check')
      await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
      await expectNoSideScroll(page)

      await page.getByRole('link', { name: /Invoice with a wrong total/ }).click()
      await expect(page).toHaveURL(/\/demo\/invoice-total-mismatch$/)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('invoice-total-mismatch.pdf')
      await expect(detail(page, 'Type')).toHaveText('Invoice')
      await expect(pages(page, 'invoice-total-mismatch.pdf')).toHaveCount(1)

      // The failed check, and its fields flagged and listed first (F13 AC-3).
      await expect(check(page, 'A3')).toHaveAttribute('data-status', 'fail')
      await expect(check(page, 'A3')).toContainText('Subtotal 247.00 − discount 0.00 + shipping 9.50 + tax 46.93 = 303.43; total is 313.43')
      const flagged = page.getByRole('region', { name: 'Flagged fields' })
      const paths = (scope: Page | ReturnType<Page['locator']>) =>
        scope.locator('[data-field]').evaluateAll((els) => els.map((e) => e.getAttribute('data-field')))
      const flaggedPaths = await paths(flagged)
      expect([...flaggedPaths].sort()).toEqual(['discount_total', 'shipping', 'subtotal', 'tax_total', 'total'])
      expect((await paths(page)).slice(0, flaggedPaths.length)).toEqual(flaggedPaths)
      await expect(field(page, 'total')).toContainText('A3: Subtotal 247.00')

      // None of the signed-in actions (F14 AC-3, F19 AC-7).
      for (const action of ['Delete', 'Approve', 'Reopen', 'Change type']) {
        await expect(page.getByRole('button', { name: action, exact: true })).toHaveCount(0)
      }
      await expect(page.getByRole('heading', { name: 'History' })).toHaveCount(0)
      await expect(detail(page, 'Status')).toHaveCount(0)

      // Corrected in the browser, the check passes on screen (Lead ruling 3).
      await page.getByLabel('Total', { exact: true }).fill('303.43')
      await page.getByLabel('Total', { exact: true }).press('Enter')
      await expect(check(page, 'A3')).toHaveAttribute('data-status', 'pass')
      await expect(field(page, 'total')).toContainText('Extracted: 313.43')
      await expect(field(page, 'total')).not.toContainText('A3:')
      await expectNoSideScroll(page)

      // Exported as CSV from the sample as edited (F13 AC-5, Lead ruling 4).
      await page.getByRole('radio', { name: /^CSV\b/ }).click()
      const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()])
      expect(zip.suggestedFilename()).toBe(`invoice-export-${today()}.zip`)
      const files = unzipSync(await bytesOf(zip))
      expect(Object.keys(files).sort()).toEqual(['documents.csv', 'line_items.csv'])
      const docs = csvRows(files['documents.csv'])
      expect(columnOf(docs, 'document_id')).toEqual([await sampleId('invoice-total-mismatch')])
      expect(columnOf(docs, 'file_name')).toEqual(['invoice-total-mismatch.pdf'])
      expect(columnOf(docs, 'approved_at')).toEqual([''])
      expect(columnOf(docs, 'total')).toEqual(['303.43'])
      expect(columnOf(docs, 'subtotal')).toEqual(['247.00'])
      expect(columnOf(csvRows(files['line_items.csv']), 'amount')).toEqual(['130.00', '75.00', '42.00'])

      // Nothing was saved: a reload shows the stored result (F13 AC-5).
      await page.reload()
      await expect(page.getByLabel('Total', { exact: true })).toHaveValue('313.43')
      await expect(check(page, 'A3')).toHaveAttribute('data-status', 'fail')
      await expect(flagged.locator('[data-field="total"]')).toBeVisible()
      expect(calls).toEqual([])
    })

    test('a visitor opens the duplicate invoice and sees the duplicate flag', async ({ page }) => {
      const calls = serverCalls(page)
      await page.goto('/demo/invoice-duplicate')
      await expect(check(page, 'U1')).toHaveAttribute('data-status', 'fail')
      await expect(check(page, 'U1')).toContainText('Duplicate of "invoice-total-mismatch.pdf": the same vendor and invoice number.')
      const flagged = page.getByRole('region', { name: 'Flagged fields' })
      for (const path of ['vendor_tax_id', 'invoice_number']) {
        await expect(flagged.locator(`[data-field="${path}"]`)).toContainText('U1: Duplicate of "invoice-total-mismatch.pdf"')
      }
      await expect(check(page, 'A3')).toHaveAttribute('data-status', 'pass')
      await expectNoSideScroll(page)
      expect(calls).toEqual([])
    })

    test('a visitor opens the photographed receipt and the two-page bank statement and sees every page', async ({ page }) => {
      const calls = serverCalls(page)
      await page.goto('/demo/receipt-photo')
      const receipt = pages(page, 'receipt-photo.png')
      await expect(receipt).toHaveCount(1)
      await expect(receipt).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/demo\/receipt-photo\.png/)
      await expect.poll(() => receipt.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0)
      // Its faded fields come first, flagged for low confidence.
      const flagged = page.getByRole('region', { name: 'Flagged fields' })
      await expect(flagged.locator('[data-field="merchant_tax_id"]')).toContainText('Low confidence (58%)')
      await expect(flagged.locator('[data-field="receipt_number"]')).toContainText('Low confidence (66%)')
      await expectNoSideScroll(page)

      await page.goto('/demo/bank-statement')
      await expect(detail(page, 'Pages')).toHaveText('2')
      const statement = pages(page, 'bank-statement.pdf')
      await expect(statement).toHaveCount(2)
      await expect(statement.nth(0)).toHaveAccessibleName('bank-statement.pdf, page 1 of 2')
      await expect(statement.nth(1)).toHaveAccessibleName('bank-statement.pdf, page 2 of 2')
      await expect(page.getByRole('region', { name: 'Document' }).locator('[data-state="shown"]')).toBeVisible()
      await expectNoSideScroll(page)
      expect(calls).toEqual([])
    })
  })
}

test('every sample opens, takes an edit, a tick and an export without a call to an Edge Function or a route handler, and the AI spend is unchanged', async ({
  page,
}) => {
  const before = await spendRows()
  const calls = serverCalls(page)

  await page.goto('/demo')
  for (const s of SAMPLES) {
    await page.goto(`/demo/${s.slug}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(s.file)
    await expect(pages(page, s.file)).toHaveCount(s.pages)

    // An edit: the first field is the language on every type.
    await page.getByLabel('Language', { exact: true }).fill('fr')
    await page.getByLabel('Language', { exact: true }).press('Enter')
    await expect(field(page, 'language')).toContainText('Extracted: en')

    // A tick, where a check fails; the others pass or are skipped, and show no tick box.
    const failed = page.locator('[data-check][data-status="fail"]')
    if ((await failed.count()) > 0) {
      const box = failed.first().getByRole('checkbox')
      await box.click()
      await expect(box).toBeChecked()
    }

    await page.getByRole('radio', { name: /^XLSX\b/ }).click()
    const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()])
    expect(xlsx.suggestedFilename()).toMatch(new RegExp(`-export-${today()}\\.xlsx$`))
  }

  expect(calls).toEqual([])
  expect(await spendRows()).toEqual(before)
})

test('a signed-in user opens the demo and a sample too', async ({ page, context, baseURL }) => {
  const user = await createUser('Demo Viewer')
  await signIn(context, baseURL!, user)
  const calls = serverCalls(page)
  await page.goto('/demo')
  await expect(page).toHaveURL(/\/demo$/)
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(SAMPLES.length)
  await expect(page.getByRole('link', { name: 'Go to your documents' })).toBeVisible()
  await page.goto('/demo/quote-date-error')
  await expect(page).toHaveURL(/\/demo\/quote-date-error$/)
  await expect(check(page, 'D2')).toHaveAttribute('data-status', 'fail')
  await expect(check(page, 'D2')).toContainText('Valid until 2026-09-05 is before quote date 2026-10-05')
  await expect(pages(page, 'quote-date-error.pdf')).toHaveCount(1)
  expect(calls).toEqual([])
})

test('an unknown slug and an unpublished sample show the not-found page', async ({ page }) => {
  for (const slug of ['no-such-sample', 'invoice-total-mismatch.pdf']) {
    const response = await page.goto(`/demo/${slug}`)
    expect(response?.status()).toBe(404)
    await expect(page.getByText('This page could not be found.')).toBeVisible()
  }

  // An unpublished sample: a row of its own, published = false, removed afterwards.
  const slug = `unpublished-${Date.now()}`
  await sql(
    `insert into public.demo_documents (slug, doc_type, title, summary, file_path, page_count, result, sort_order, published)
     select $1, doc_type, 'Unpublished', summary, $1 || '.pdf', page_count, result, 98, false
     from public.demo_documents where slug = 'invoice-total-mismatch'`,
    [slug],
  )
  try {
    const response = await page.goto(`/demo/${slug}`)
    expect(response?.status()).toBe(404)
    await expect(page.getByText('This page could not be found.')).toBeVisible()
    await page.goto('/demo')
    await expect(page.getByText('Unpublished')).toHaveCount(0)
  } finally {
    await sql('delete from public.demo_documents where slug = $1', [slug])
  }
})
