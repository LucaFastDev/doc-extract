import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { personalWorkspace, switcher } from './support/workspace'

// Issue #66 criteria 1 and 2: a current workspace named 100 characters, the most it can have (issue
// #69), with no spaces keeps every signed-in page inside the window, at a phone's width and at a
// desktop's.

const NAME = 'W'.repeat(100)
// Each emoji is outside the Basic Multilingual Plane: one character, two UTF-16 units.
const EMOJI_NAME = '😀'.repeat(100)
const TOO_LONG_NAME = 'W'.repeat(101)
const LIMIT_MESSAGE = 'Use 100 characters or fewer for the workspace name.'

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

    // Issue #80 criterion 2: 100 emoji are 200 UTF-16 units, within the limit of 100 characters.
    test('the create form accepts a name of 100 emoji and the new workspace shows its full name', async ({ page, context, baseURL }) => {
      const user = await createUser()
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Create workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create workspace' })
      const field = dialog.getByLabel('Name')
      await field.click()
      await page.keyboard.insertText(EMOJI_NAME)
      await expect(field).toHaveValue(EMOJI_NAME)
      await dialog.getByRole('button', { name: 'Create' }).click()

      await expect(dialog).toBeHidden()
      await expect(switcher(page)).toHaveAccessibleName(`Workspace: ${EMOJI_NAME}`)
      await expect(page.getByText('No documents in')).toContainText(EMOJI_NAME)
      await noSideScroll(page)
      const rows = await sql(
        `select 1 from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
         where m.user_id = $1 and w.name = $2`,
        [user.id, EMOJI_NAME],
      )
      expect(rows).toHaveLength(1)
    })

    // Issue #80 criterion 3: the action refuses, and what was typed stays in the field.
    test('101 characters in the create form show the limit message and stay in the field', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await createUser())
      await page.goto('/documents')

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Create workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create workspace' })
      const field = dialog.getByLabel('Name')
      await field.click()
      await page.keyboard.insertText(TOO_LONG_NAME)
      await dialog.getByRole('button', { name: 'Create' }).click()

      await expect(dialog.getByRole('alert')).toHaveText(LIMIT_MESSAGE)
      await expect(field).toHaveValue(TOO_LONG_NAME)
    })

    test('101 characters in the rename form show the limit message and stay in the field', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await setUp(false))
      await page.goto('/documents')

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Rename workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Rename workspace' })
      const field = dialog.getByLabel('Name')
      await field.fill(TOO_LONG_NAME)
      await dialog.getByRole('button', { name: 'Save' }).click()

      await expect(dialog.getByRole('alert')).toHaveText(LIMIT_MESSAGE)
      await expect(field).toHaveValue(TOO_LONG_NAME)
    })

    // Issue #80 criterion 4.
    test('the rename form’s name field has no maxlength, and neither has the delete dialog’s typed name', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!, await setUp(false))
      await page.goto('/documents')

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Rename workspace' }).click()
      const rename = page.getByRole('dialog', { name: 'Rename workspace' })
      await expect(rename.getByLabel('Name')).not.toHaveAttribute('maxlength')
      await page.keyboard.press('Escape')
      await expect(rename).toBeHidden()

      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
      const typed = page.getByRole('dialog', { name: 'Delete workspace' }).getByRole('textbox')
      await expect(typed).toBeVisible()
      await expect(typed).not.toHaveAttribute('maxlength')
    })
  })
}
