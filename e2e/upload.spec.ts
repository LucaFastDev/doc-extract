import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql, type TestUser } from './support/auth'
import { dropFiles, dropZone, jpegFile, pdfFile, picker, pngFile } from './support/files'
import { expectNoSideScroll } from './support/workspace'

// Upload and the document list (PRD US-1.1 AC-1 to AC-6, US-10.1, F14's 7-day notice, OQ-2,
// OQ-4, OQ-35, OQ-42, OQ-45), at phone width (OQ-40). submit-document runs in the local stack.
test.use({ viewport: { width: 360, height: 740 } })

// A cold edge runtime loads the function's npm modules on its first request, which can take longer
// than an assertion waits; one request first, refused for its empty body, starts it.
test.beforeAll(async () => {
  test.setTimeout(90_000)
  const response = await fetch(new URL('/functions/v1/submit-document', process.env.NEXT_PUBLIC_SUPABASE_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(60_000),
  })
  expect(response.status).toBe(400)
})

async function workspaceOf(user: TestUser): Promise<string> {
  const [row] = await sql<{ workspace_id: string }>('select workspace_id from public.workspace_members where user_id = $1', [
    user.id,
  ])
  return row.workspace_id
}

async function documents(ws: string) {
  return sql<{ file_name: string; status: string; page_count: number | null; sha256: string | null }>(
    'select file_name, status, page_count, sha256 from public.documents where workspace_id = $1 order by file_name',
    [ws],
  )
}

async function accountPagesUsed(user: TestUser): Promise<number> {
  const rows = await sql<{ pages_used: number }>('select pages_used from public.account_page_usage where user_id = $1', [
    user.id,
  ])
  return rows[0]?.pages_used ?? 0
}

/** The upload control's refusal; Next.js's route announcer is an alert too. */
function refusal(page: Page) {
  return page.getByRole('alert', { name: 'Upload refused' })
}

function row(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })
}

async function openDocuments(page: Page, context: Parameters<typeof signIn>[0], baseURL: string) {
  const user = await createUser()
  await signIn(context, baseURL, user)
  await page.goto('/documents')
  return { user, ws: await workspaceOf(user) }
}

test('upload a PDF by file picker: it is listed as Queued with its page count', async ({ page, context, baseURL }) => {
  const { user, ws } = await openDocuments(page, context, baseURL!)
  await expect(page.getByText('Files are deleted 7 days after upload.')).toBeVisible()

  await picker(page).setInputFiles(await pdfFile('Invoice 1042.pdf', 3))

  await expect(row(page, 'Invoice 1042.pdf').getByRole('cell')).toHaveText(['Invoice 1042.pdf', '', 'Queued', '3'])
  const rows = await documents(ws)
  expect(rows).toEqual([
    { file_name: 'Invoice 1042.pdf', status: 'queued', page_count: 3, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
  ])
  expect(await accountPagesUsed(user)).toBe(3)
  await expectNoSideScroll(page)

  // Still there after a reload, read from the database.
  await page.reload()
  await expect(row(page, 'Invoice 1042.pdf').getByRole('cell')).toHaveText(['Invoice 1042.pdf', '', 'Queued', '3'])
})

test('upload an image by file picker: it counts one page', async ({ page, context, baseURL }) => {
  const { ws } = await openDocuments(page, context, baseURL!)
  await picker(page).setInputFiles(pngFile('receipt.png'))
  await expect(row(page, 'receipt.png').getByRole('cell')).toHaveText(['receipt.png', '', 'Queued', '1'])
  expect(await documents(ws)).toMatchObject([{ file_name: 'receipt.png', status: 'queued', page_count: 1 }])
})

test('upload by drag and drop', async ({ page, context, baseURL }) => {
  const { ws } = await openDocuments(page, context, baseURL!)
  await expect(dropZone(page)).toBeVisible()
  await dropFiles(page, [await pdfFile('Dropped statement.pdf', 2), jpegFile('dropped photo.jpg')])

  await expect(row(page, 'Dropped statement.pdf').getByRole('cell')).toHaveText(['Dropped statement.pdf', '', 'Queued', '2'])
  await expect(row(page, 'dropped photo.jpg').getByRole('cell')).toHaveText(['dropped photo.jpg', '', 'Queued', '1'])
  expect((await documents(ws)).map((d) => [d.file_name, d.status]).sort()).toEqual([
    ['Dropped statement.pdf', 'queued'],
    ['dropped photo.jpg', 'queued'],
  ])
})

test('upload several files at once: each becomes its own document', async ({ page, context, baseURL }) => {
  const { ws } = await openDocuments(page, context, baseURL!)
  await picker(page).setInputFiles([await pdfFile('a.pdf', 1), await pdfFile('b.pdf', 2), pngFile('c.png')])

  await expect(row(page, 'a.pdf').getByRole('cell')).toHaveText(['a.pdf', '', 'Queued', '1'])
  await expect(row(page, 'b.pdf').getByRole('cell')).toHaveText(['b.pdf', '', 'Queued', '2'])
  await expect(row(page, 'c.png').getByRole('cell')).toHaveText(['c.png', '', 'Queued', '1'])
  expect((await documents(ws)).map((d) => [d.file_name, d.page_count])).toEqual([
    ['a.pdf', 1],
    ['b.pdf', 2],
    ['c.png', 1],
  ])
})

test('a file of another type is refused before upload, naming the accepted types', async ({ page, context, baseURL }) => {
  const { ws } = await openDocuments(page, context, baseURL!)
  await picker(page).setInputFiles([
    await pdfFile('fine.pdf', 1),
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  ])
  await expect(refusal(page)).toContainText(
    'notes.txt is not a PDF, JPEG, PNG or WebP file. Accepted types: PDF, JPEG, PNG and WebP.',
  )
  await expect(refusal(page)).toContainText('Nothing was uploaded.')
  await expectNoSideScroll(page)
  expect(await documents(ws)).toEqual([])
})

test('a file over 10 MB is refused before upload, naming the limit', async ({ page, context, baseURL }) => {
  const { ws } = await openDocuments(page, context, baseURL!)
  const big = Buffer.alloc(10 * 1024 * 1024 + 1)
  Buffer.from('%PDF-1.7\n').copy(big)
  await picker(page).setInputFiles({ name: 'huge scan.pdf', mimeType: 'application/pdf', buffer: big })
  await expect(refusal(page)).toContainText('huge scan.pdf is over the 10 MB limit.')
  expect(await documents(ws)).toEqual([])
})

// Issue #28: an image may be at most 7,500,000 bytes, which base64-encode to the API's image limit.
test('an image over 7.5 MB is refused before upload, naming the image limit', async ({ page, context, baseURL }) => {
  const { ws } = await openDocuments(page, context, baseURL!)
  await expect(
    page.getByText(
      'Drop up to 10 files here, or choose them. PDF, JPEG, PNG or WebP. PDFs at most 10 MB, images at most 7.5 MB, and 10 pages each.',
    ),
  ).toBeVisible()
  const big = Buffer.alloc(7_500_001)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(big)
  await picker(page).setInputFiles({ name: 'big photo.jpg', mimeType: 'image/jpeg', buffer: big })
  await expect(refusal(page)).toContainText('big photo.jpg is over the 7.5 MB limit for images.')
  await expect(refusal(page)).toContainText('Nothing was uploaded.')
  expect(await documents(ws)).toEqual([])
  const objects = await sql("select 1 from storage.objects where bucket_id = 'documents' and name like $1 || '/%'", [ws])
  expect(objects).toEqual([])
})

test('more than 10 files are refused, naming the limit, and none is uploaded', async ({ page, context, baseURL }) => {
  const { ws } = await openDocuments(page, context, baseURL!)
  await picker(page).setInputFiles(Array.from({ length: 11 }, (_, i) => pngFile(`photo ${i + 1}.png`)))
  await expect(refusal(page)).toContainText('You can upload at most 10 files at once. Nothing was uploaded.')
  expect(await documents(ws)).toEqual([])
  const objects = await sql("select 1 from storage.objects where bucket_id = 'documents' and name like $1 || '/%'", [ws])
  expect(objects).toEqual([])
})

test('a PDF over 10 pages is refused, naming the limit, and no pages are counted', async ({ page, context, baseURL }) => {
  const { user, ws } = await openDocuments(page, context, baseURL!)
  await picker(page).setInputFiles(await pdfFile('Long statement.pdf', 11))
  await expect(refusal(page)).toContainText('Long statement.pdf has 11 pages. A document can have at most 10 pages.')
  await expect(row(page, 'Long statement.pdf')).toHaveCount(0)
  expect(await accountPagesUsed(user)).toBe(0)
  expect(await sql('select 1 from public.page_usage where workspace_id = $1 and pages_used > 0', [ws])).toEqual([])
  expect(await documents(ws)).toMatchObject([{ file_name: 'Long statement.pdf', status: 'rejected' }])
})

test('an upload over the allowances is refused, saying how many pages remain, and counts nothing', async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createUser()
  await sql('insert into public.account_page_usage (user_id, pages_used) values ($1, 9)', [user.id])
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await expect(page.getByText('1 of your account’s 10 pages left')).toBeVisible()

  await picker(page).setInputFiles(await pdfFile('Quote.pdf', 2))
  await expect(refusal(page)).toContainText('Quote.pdf has 2 pages, but only 1 page remains')
  await expect(row(page, 'Quote.pdf')).toHaveCount(0)
  expect(await accountPagesUsed(user)).toBe(9)

  // One page still fits.
  await picker(page).setInputFiles(pngFile('last.png'))
  await expect(row(page, 'last.png').getByRole('cell')).toHaveText(['last.png', '', 'Queued', '1'])
  expect(await accountPagesUsed(user)).toBe(10)
  await expect(page.getByText('0 of your account’s 10 pages left')).toBeVisible()
})

test('a failed refresh of the pages left keeps the last counts and says so until a refresh succeeds', async ({
  page,
  context,
  baseURL,
}) => {
  const stale = "Couldn't update pages left. Reload the page to see the current count."
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await openDocuments(page, context, baseURL!)
  await expect(page.getByText('10 of your account’s 10 pages left')).toBeVisible()

  await page.route('**/rest/v1/rpc/get_page_allowance', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"unavailable"}' }),
  )
  await picker(page).setInputFiles(pngFile('first.png'))
  await expect(row(page, 'first.png').getByRole('cell')).toHaveText(['first.png', '', 'Queued', '1'])
  await expect(page.getByText(stale)).toBeVisible()
  await expect(page.getByText('10 of your account’s 10 pages left')).toBeVisible()
  expect(errors.some((e) => e.includes('The pages left could not be refreshed after an upload.'))).toBe(true)
  await expectNoSideScroll(page)

  await page.unroute('**/rest/v1/rpc/get_page_allowance')
  await picker(page).setInputFiles(pngFile('second.png'))
  await expect(row(page, 'second.png').getByRole('cell')).toHaveText(['second.png', '', 'Queued', '1'])
  await expect(page.getByText('8 of your account’s 10 pages left')).toBeVisible()
  await expect(page.getByText(stale)).toHaveCount(0)
})

test('a status change made in the database reaches the open list without a reload', async ({ page, context, baseURL }) => {
  const user = await createUser()
  const ws = await workspaceOf(user)
  const [doc] = await sql<{ id: string }>(
    `insert into public.documents (workspace_id, uploaded_by, status, file_name, mime_type, byte_size, page_count, storage_path)
     values ($1::uuid, $2, 'queued', 'Live.pdf', 'application/pdf', 100, 4, $1::text || '/x/original') returning id`,
    [ws, user.id],
  )
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await expect(row(page, 'Live.pdf').getByRole('cell')).toHaveText(['Live.pdf', '', 'Queued', '4'])
  // The page has subscribed once it says so.
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'subscribed')

  await sql("update public.documents set status = 'processing' where id = $1", [doc.id])
  await expect(row(page, 'Live.pdf').getByRole('cell')).toHaveText(['Live.pdf', '', 'Processing', '4'], { timeout: 5000 })

  await sql("update public.documents set status = 'needs_review', doc_type = 'invoice' where id = $1", [doc.id])
  await expect(row(page, 'Live.pdf').getByRole('cell')).toHaveText(['Live.pdf', 'Invoice', 'Needs review', '4'], {
    timeout: 5000,
  })
  await expectNoSideScroll(page)
})
