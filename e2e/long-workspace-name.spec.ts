import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { personalWorkspace } from './support/workspace'

// Issue #66 criteria 1 and 2: a current workspace named 200 characters with no spaces keeps every
// signed-in page inside the window, at a phone's width and at a desktop's.

const NAME = 'W'.repeat(200)

const VIEWPORTS = [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const

async function noSideScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
}

/** The user's own workspace, named NAME, optionally with one document in it. */
async function setUp(withDocument: boolean) {
  const user = await createUser()
  const ws = await personalWorkspace(user, NAME)
  if (withDocument) {
    await sql(
      `insert into public.documents (workspace_id, uploaded_by, status, file_name, mime_type, byte_size, page_count, storage_path)
       values ($1::uuid, $2, 'queued', 'Invoice.pdf', 'application/pdf', 100, 1, $1::text || '/x/original')`,
      [ws, user.id],
    )
  }
  return user
}

for (const [label, viewport] of VIEWPORTS) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    test('the document list with no documents stays inside the window', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await setUp(false))
      await page.goto('/documents')
      await expect(page.getByText('No documents in')).toContainText(NAME)
      await noSideScroll(page)
    })

    test('the document list with one document stays inside the window', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await setUp(true))
      await page.goto('/documents')
      await expect(page.getByRole('cell', { name: 'Invoice.pdf', exact: true })).toBeVisible()
      await noSideScroll(page)
    })

    test('the export page stays inside the window', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await setUp(false))
      await page.goto('/documents/export')
      await expect(page.getByRole('heading', { name: 'Export' })).toBeVisible()
      await expect(page.getByText('Approved documents of one type in')).toContainText(NAME)
      await noSideScroll(page)
    })

    test('the members page stays inside the window', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await setUp(false))
      await page.goto('/members')
      await expect(page.getByRole('heading', { name: 'Members', exact: true, level: 1 })).toBeVisible()
      await expect(page.getByText('People in')).toContainText(NAME)
      await noSideScroll(page)
    })

    test('the billing page stays inside the window', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await setUp(false))
      await page.goto('/billing')
      await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible()
      await expect(page.getByText('The plan and pages of')).toContainText(NAME)
      await noSideScroll(page)
    })
  })
}
