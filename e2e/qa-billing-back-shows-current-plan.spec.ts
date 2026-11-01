import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { proPlan, setPlan } from './support/stripe'
import { personalWorkspace, switcher } from './support/workspace'

// The billing page shows the current plan (issue #50 criterion 9, PRD US-11.1 AC-1), and after
// returning from Checkout it picks up the new plan by itself (criterion 11). Going to another page
// and pressing Back must not bring back the plan from before the payment. Each test asserts the
// correct behaviour. No call reaches Stripe: the return is the page's own URL and the webhook event
// is a signed fixture.

function yourPlan(page: Page) {
  return page.getByRole('region', { name: 'Your plan' })
}

function figure(page: Page, label: string) {
  return yourPlan(page).locator('dl > div').filter({ hasText: label }).getByRole('definition')
}

async function goToMembersAndBack(page: Page) {
  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/billing$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible()
}

for (const { name, viewport } of [
  { name: 'phone width', viewport: { width: 360, height: 740 } },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
]) {
  test.describe(`at ${name}`, () => {
    test.use({ viewport })

    test('Back to the billing page after the page picked up Pro still shows Pro', async ({ page, context, baseURL, request }) => {
      const owner = await createUser('Olivia Owner')
      const ws = await personalWorkspace(owner, 'Acme books')
      await signIn(context, baseURL!, owner)

      // Returned from Checkout, the page re-reads until the webhook has made the workspace Pro.
      await page.goto(`/billing?checkout=success&workspace=${ws}`)
      await expect(page).toHaveURL(/\/billing$/)
      await expect(figure(page, 'Current plan')).toHaveText('Free')
      await setPlan(ws, proPlan(ws))
      await expect(figure(page, 'Current plan')).toHaveText('Pro')
      await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeVisible()

      await goToMembersAndBack(page)

      await expect(figure(page, 'Current plan')).toHaveText('Pro')
      await expect(figure(page, 'Pages left this month')).toHaveText('500 of 500')
      await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(0)
    })
  })
}
