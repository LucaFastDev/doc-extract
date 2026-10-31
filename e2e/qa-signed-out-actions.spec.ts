import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'

// QA (PR #13): a page left open after the session ended (signed out in another tab). Using the
// header's actions must send the signed-out visitor to sign-in with the page as next (PRD US-9.1
// AC-2, OQ-34), not throw in the browser.
test.use({ viewport: { width: 360, height: 740 } })

function errors(page: Page) {
  const log: string[] = []
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') log.push(`console.error: ${m.text()}`)
  })
  return log
}

async function openThenSignOutElsewhere(page: Page, context: BrowserContext, baseURL: string) {
  const user = await createUser()
  await sql(
    `with ws as (insert into public.workspaces (name, created_by) values ('Other', $1) returning id)
     insert into public.workspace_members (workspace_id, user_id, role) select id, $1, 'owner' from ws`,
    [user.id],
  )
  await signIn(context, baseURL, user)
  await page.goto('/documents')
  await expect(page.getByRole('button', { name: 'Workspace: Personal' })).toBeVisible()

  const elsewhere = await context.newPage()
  await elsewhere.goto('/documents')
  await elsewhere.getByRole('button', { name: 'Sign out' }).click()
  await expect(elsewhere).toHaveURL((url) => url.pathname === '/')
  await elsewhere.close()
}

test('switching workspace after the session ended sends the visitor to sign-in', async ({ page, context, baseURL }) => {
  const log = errors(page)
  await openThenSignOutElsewhere(page, context, baseURL!)

  await page.getByRole('button', { name: 'Workspace: Personal' }).click()
  await page.getByRole('menuitemradio', { name: 'Other' }).click()

  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  expect(new URL(page.url()).searchParams.get('next')).toBe('/documents')
  expect(log).toEqual([])
})

test('creating a workspace after the session ended sends the visitor to sign-in', async ({ page, context, baseURL }) => {
  const log = errors(page)
  await openThenSignOutElsewhere(page, context, baseURL!)

  await page.getByRole('button', { name: 'Workspace: Personal' }).click()
  await page.getByRole('menuitem', { name: 'Create workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create workspace' })
  await dialog.getByLabel('Name').fill('After sign-out')
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  expect(new URL(page.url()).searchParams.get('next')).toBe('/documents')
  expect(log).toEqual([])
})

test('signing out of a page whose session already ended lands signed out, without an error', async ({
  page,
  context,
  baseURL,
}) => {
  const log = errors(page)
  await openThenSignOutElsewhere(page, context, baseURL!)

  await page.getByRole('button', { name: 'Sign out' }).click()

  await expect(page).toHaveURL((url) => url.pathname === '/' || url.pathname === '/sign-in')
  expect(log).toEqual([])
})
