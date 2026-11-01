import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql, type TestUser } from './support/auth'
import { addMember, personalWorkspace, switcher, useWorkspace } from './support/workspace'

// What the billing page does after a return from Checkout, once the ?checkout=success marker has been
// used (PRD US-11.1, Lead ruling 6 on #50: "No timer runs otherwise"). Each test asserts the correct
// behaviour. No call reaches Stripe: the return is the page's own URL.

const CHECKING = 'Checking your plan…'
const STILL_FREE = 'Your payment went through. Your plan will update shortly.'

async function returnFromCheckout(page: Page) {
  await page.goto('/billing?checkout=success')
  await expect(page).toHaveURL(/\/billing$/)
  await expect(page.getByText(CHECKING)).toBeVisible()
}

async function secondWorkspace(user: TestUser, name: string) {
  const [row] = await sql<{ id: string }>('insert into public.workspaces (name, created_by) values ($1, $2) returning id', [name, user.id])
  await addMember(row.id, user, 'owner')
  return row.id
}

test('browser Back to the billing page after a Checkout return shows the billing page', async ({ page, context, baseURL }) => {
  const owner = await createUser('Olivia Owner')
  await personalWorkspace(owner, 'Acme books')
  await signIn(context, baseURL!, owner)
  await returnFromCheckout(page)

  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()

  await page.goBack()

  await expect(page).toHaveURL(/\/billing$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible()
})

test('switching to another workspace after a Checkout return says nothing about a payment there', async ({ page, context, baseURL }) => {
  test.setTimeout(60_000)
  const owner = await createUser('Olivia Owner')
  const paid = await personalWorkspace(owner, 'Paid workspace')
  await secondWorkspace(owner, 'Unpaid workspace')
  await signIn(context, baseURL!, owner)
  await useWorkspace(context, baseURL!, paid)
  await returnFromCheckout(page)

  await switcher(page).click()
  await page.getByRole('menuitemradio', { name: 'Unpaid workspace' }).click()
  await expect(page.getByRole('main')).toContainText('Unpaid workspace')

  await expect(page.getByText(CHECKING)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()

  // Longer than the 20 seconds of re-reads.
  await page.waitForTimeout(21_000)
  await expect(page.getByText(STILL_FREE)).toHaveCount(0)
})

test('renaming the workspace after a Checkout return does not bring the marker back', async ({ page, context, baseURL }) => {
  const owner = await createUser('Olivia Owner')
  await personalWorkspace(owner, 'Acme books')
  await signIn(context, baseURL!, owner)
  await returnFromCheckout(page)

  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Rename workspace' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('Renamed books')
  await page.getByRole('dialog').getByRole('button', { name: /save|rename/i }).click()
  await expect(page.getByRole('main')).toContainText('Renamed books')

  await expect(page).toHaveURL(/\/billing$/)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible()
  await expect(page.getByText(CHECKING)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
})
