import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { setPlan } from './support/stripe'
import { personalWorkspace } from './support/workspace'

// Every call the billing page makes has a time limit (issue #94, rulings 1 to 5), so a call that never
// answers cannot leave Upgrade disabled. A route handler that never answers holds the call; the specs
// run in real time, with no fake clock, because the limit is an AbortSignal.timeout.

const CHECKING = 'Checking your plan…'
const STILL_FREE = 'Your payment went through. Your plan will update shortly.'
const NO_CONNECTION = 'That did not work. Check your connection and try again.'
const RETURN_PATH = '/api/billing/checkout-return'
const SESSION_ID = 'cs_test_return'

/** A route handler that holds the request and never answers it. */
const never = () => new Promise<void>(() => {})

function yourPlan(page: Page) {
  return page.getByRole('region', { name: 'Your plan' })
}

function currentPlan(page: Page) {
  return yourPlan(page).locator('dl > div').filter({ hasText: 'Current plan' }).getByRole('definition')
}

function checkoutReturnPath(ws: string) {
  return `/billing?checkout=success&workspace=${ws}&session_id=${SESSION_ID}`
}

test.describe('a billing call that never answers', () => {
  test('a return check that never answers: Checking your plan goes, no message shows, Upgrade is enabled', async ({ page, context, baseURL }) => {
    test.setTimeout(60_000)
    const owner = await createUser('Olivia Owner')
    const ws = await personalWorkspace(owner, 'Acme books')
    await page.route(`**${RETURN_PATH}`, never)
    await signIn(context, baseURL!, owner)
    await page.goto(checkoutReturnPath(ws))
    await expect(page.getByText(CHECKING)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeDisabled()

    await expect(page.getByText(CHECKING)).toHaveCount(0, { timeout: 25_000 })
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
    await expect(page.getByText(STILL_FREE)).toHaveCount(0)
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
    await expect(currentPlan(page)).toHaveText('Free')
  })

  test('an Upgrade whose checkout call never answers shows the connection message and enables Upgrade', async ({ page, context, baseURL }) => {
    test.setTimeout(60_000)
    const owner = await createUser('Olivia Owner')
    await personalWorkspace(owner, 'Acme books')
    await page.route('**/api/billing/checkout', never)
    await signIn(context, baseURL!, owner)
    await page.goto('/billing')
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()

    await page.getByRole('button', { name: 'Upgrade' }).click()
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeDisabled()

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(NO_CONNECTION, { timeout: 25_000 })
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
  })

  test('a Manage or cancel whose portal call never answers shows the connection message and enables the button', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(60_000)
    const owner = await createUser('Olivia Owner')
    const ws = await personalWorkspace(owner, 'Acme books')
    await setPlan(ws, { plan: 'pro', customer: `cus_${ws}` })
    await page.route('**/api/billing/portal', never)
    await signIn(context, baseURL!, owner)
    await page.goto('/billing')
    await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeEnabled()

    await page.getByRole('button', { name: 'Manage or cancel' }).click()
    await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeDisabled()

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(NO_CONNECTION, { timeout: 25_000 })
    await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeEnabled()
  })

  test('re-reads that never answer: after the last one runs out, the payment message shows and Upgrade is enabled', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000)
    const owner = await createUser('Olivia Owner')
    const ws = await personalWorkspace(owner, 'Acme books')
    await page.route(`**${RETURN_PATH}`, (route) => route.fulfill({ status: 200, json: { paid: true } }))
    await page.route('**/rest/v1/workspaces*', never)
    await signIn(context, baseURL!, owner)
    await page.goto(checkoutReturnPath(ws))
    await expect(page.getByText(CHECKING)).toBeVisible()

    await expect(page.getByText(CHECKING)).toHaveCount(0, { timeout: 50_000 })
    await expect(page.getByText(STILL_FREE)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
    await expect(currentPlan(page)).toHaveText('Free')
  })

  test('the read after a 409 that never answers leaves the error and the plan, and enables Upgrade', async ({ page, context, baseURL }) => {
    test.setTimeout(60_000)
    const owner = await createUser('Olivia Owner')
    await personalWorkspace(owner, 'Acme books')
    await page.route('**/api/billing/checkout', (route) =>
      route.fulfill({ status: 409, json: { error: 'This workspace is already on Pro.' } }),
    )
    await signIn(context, baseURL!, owner)
    await page.goto('/billing')
    await expect(currentPlan(page)).toHaveText('Free')
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
    // The read on mount has landed; from here the plan table never answers.
    await page.route('**/rest/v1/workspaces*', never)

    await page.getByRole('button', { name: 'Upgrade' }).click()
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('This workspace is already on Pro.')
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeDisabled()

    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled({ timeout: 25_000 })
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('This workspace is already on Pro.')
    await expect(currentPlan(page)).toHaveText('Free')
  })
})
