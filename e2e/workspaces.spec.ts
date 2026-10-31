import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'

// The workspace switcher: switch, create and rename (PRD US-8.1 AC-3 and AC-4, OQ-17), at phone
// width (OQ-40).
test.use({ viewport: { width: 360, height: 740 } })

function switcher(page: Page) {
  return page.getByRole('button', { name: /^Workspace: / })
}

async function expectNoSideScroll(page: Page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(360)
}

test('create a workspace: it opens, and the user owns it', async ({ page, context, baseURL }) => {
  const user = await createUser()
  await signIn(context, baseURL!, user)
  await page.goto('/documents')

  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Create workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create workspace' })
  await expectNoSideScroll(page)
  await dialog.getByLabel('Name').fill('Acme Ltd books')
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(dialog).toBeHidden()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Acme Ltd books')
  await expect(page.getByText('No documents in Acme Ltd books yet.')).toBeVisible()
  const rows = await sql<{ role: string }>(
    `select m.role from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
     where m.user_id = $1 and w.name = 'Acme Ltd books'`,
    [user.id],
  )
  expect(rows).toEqual([{ role: 'owner' }])
})

test('create refuses a blank name', async ({ page, context, baseURL }) => {
  const user = await createUser()
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Create workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create workspace' })
  await dialog.getByLabel('Name').fill('   ')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Enter a name for the workspace.')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
  const rows = await sql('select 1 from public.workspace_members where user_id = $1', [user.id])
  expect(rows).toHaveLength(1)
})

test('switch between workspaces, and the choice is kept across pages', async ({ page, context, baseURL }) => {
  const user = await createUser()
  await sql(
    `with ws as (insert into public.workspaces (name, created_by) values ('Shared books', $1) returning id)
     insert into public.workspace_members (workspace_id, user_id, role) select id, $1, 'owner' from ws`,
    [user.id],
  )
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')

  await switcher(page).click()
  const items = page.getByRole('menuitemradio')
  await expect(items).toHaveText(['Personal', 'Shared books'])
  await expectNoSideScroll(page)
  await page.getByRole('menuitemradio', { name: 'Shared books' }).click()

  await expect(switcher(page)).toHaveAccessibleName('Workspace: Shared books')
  await expect(page.getByText('No documents in Shared books yet.')).toBeVisible()
  await page.reload()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Shared books')
})

test('a workspace cookie naming someone else’s workspace falls back to the personal one', async ({
  page,
  context,
  baseURL,
}) => {
  const other = await createUser()
  const [ws] = await sql<{ workspace_id: string }>(
    'select workspace_id from public.workspace_members where user_id = $1',
    [other.id],
  )
  await signIn(context, baseURL!, await createUser())
  await context.addCookies([{ name: 'workspace', value: ws.workspace_id, url: baseURL! }])
  await page.goto('/documents')
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
})

test('an owner renames the workspace', async ({ page, context, baseURL }) => {
  const user = await createUser()
  await signIn(context, baseURL!, user)
  await page.goto('/documents')

  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Rename workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename workspace' })
  await expect(dialog.getByLabel('Name')).toHaveValue('Personal')
  await expectNoSideScroll(page)
  await dialog.getByLabel('Name').fill('My bookkeeping')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(dialog).toBeHidden()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: My bookkeeping')
  const rows = await sql<{ name: string }>(
    'select w.name from public.workspaces w join public.workspace_members m on m.workspace_id = w.id where m.user_id = $1',
    [user.id],
  )
  expect(rows).toEqual([{ name: 'My bookkeeping' }])
})

test('a member who is not an owner is not offered rename', async ({ page, context, baseURL }) => {
  const owner = await createUser()
  const member = await createUser()
  await sql(
    `insert into public.workspace_members (workspace_id, user_id, role)
     select workspace_id, $2, 'member' from public.workspace_members where user_id = $1`,
    [owner.id, member.id],
  )
  const [ws] = await sql<{ workspace_id: string }>(
    'select workspace_id from public.workspace_members where user_id = $1',
    [owner.id],
  )
  await signIn(context, baseURL!, member)
  await context.addCookies([{ name: 'workspace', value: ws.workspace_id, url: baseURL! }])
  await page.goto('/documents')

  await switcher(page).click()
  await expect(page.getByRole('menuitemradio', { name: 'Personal' })).toHaveCount(2)
  await expect(page.getByRole('menuitem', { name: 'Create workspace' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Rename workspace' })).toHaveCount(0)
})
