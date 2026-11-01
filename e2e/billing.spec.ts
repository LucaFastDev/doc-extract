import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { postEvent, postSubscriptionDeleted, postSubscriptionUpdated, setPagesUsed, setPlan, subscriptionFixture } from './support/stripe'
import { addMember, expectNoSideScroll, personalWorkspace, switcher, useWorkspace } from './support/workspace'

// The billing page and its routes (PRD US-11.1, OQ-20, OQ-24, OQ-36, OQ-37, OQ-45; issue #50). No
// call reaches Stripe (Lead ruling 7): the specs intercept the two /api/billing/* calls and post
// signed fixture events to the webhook, and the dev server has no STRIPE_SECRET_KEY.

const NOTICE =
  'Billing here is a test-mode demonstration. Only Stripe test cards are accepted and no real money is ever charged. To try it, use the card 4242 4242 4242 4242 with any future date and any CVC.'
const STILL_FREE = 'Your payment went through. Your plan will update shortly.'
const CHECKOUT_URL = 'https://checkout.stripe.test/session'
const PORTAL_URL = 'https://billing.stripe.test/session'

function yourPlan(page: Page) {
  return page.getByRole('region', { name: 'Your plan' })
}

function figure(page: Page, label: string) {
  return yourPlan(page).locator('dl > div').filter({ hasText: label }).getByRole('definition')
}

async function expectPlan(page: Page, plan: string, used: string, left: string) {
  await expect(figure(page, 'Current plan')).toHaveText(plan)
  await expect(figure(page, 'Pages used this month')).toHaveText(used)
  await expect(figure(page, 'Pages left this month')).toHaveText(left)
}

/** Fulfils the browser's call to a billing route with the given answer, and records what it sent. */
async function interceptBillingCall(page: Page, path: string, answer: { status: number; body: unknown }) {
  const sent: unknown[] = []
  await page.route(`**${path}`, async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: answer.status, json: answer.body })
  })
  return sent
}

/** A stand-in for Stripe's hosted page, so going there stays off the network. */
async function stubHostedPage(context: BrowserContext, url: string) {
  await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Hosted page</title>' }))
}

/** Counts the browser's own reads of the plan; the page's first read happens on the server. */
function countPlanReads(page: Page) {
  const reads = { count: 0 }
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/rest/v1/workspaces')) reads.count += 1
  })
  return reads
}

test.describe('no call reaches Stripe', () => {
  // The whole file: any request a page makes to Stripe would fail its test.
  test.beforeEach(({ page }, testInfo) => {
    page.on('request', (request) => {
      if (/(^|\.)stripe\.com$/.test(new URL(request.url()).hostname)) {
        testInfo.annotations.push({ type: 'stripe-call', description: request.url() })
      }
    })
  })
  test.afterEach(({}, testInfo) => {
    expect(testInfo.annotations.filter((a) => a.type === 'stripe-call')).toEqual([])
  })

  for (const { name, viewport } of [
    { name: 'phone width', viewport: { width: 360, height: 740 } },
    { name: 'desktop', viewport: { width: 1280, height: 800 } },
  ]) {
    test.describe(`the billing page at ${name}`, () => {
      test.use({ viewport })

      async function checkSideScroll(page: Page) {
        if (viewport.width === 360) await expectNoSideScroll(page)
      }

      test('an owner on Free sees the plan, the pages, the plans, the notice and Upgrade', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        await setPagesUsed(ws, 3)
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')

        await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible()
        await expect(page.getByRole('main')).toContainText('Acme books')
        await expectPlan(page, 'Free', '3', '17 of 20')
        await expect(page.getByText(NOTICE)).toBeVisible()

        const plans = page.getByRole('region', { name: 'Plans' })
        await expect(plans.getByRole('listitem', { name: 'Free' })).toContainText('20 pages a month per workspace')
        await expect(plans.getByRole('listitem', { name: 'Free' })).toContainText('$0')
        await expect(plans.getByRole('listitem', { name: 'Pro' })).toContainText('500 pages a month per workspace')
        await expect(plans.getByRole('listitem', { name: 'Pro' })).toContainText('$19 a month')

        await expect(page.getByRole('button', { name: 'Upgrade' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Manage or cancel' })).toHaveCount(0)
        await checkSideScroll(page)
      })

      test('an owner on Pro sees Manage or cancel and no end date while the subscription renews', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        await setPlan(ws, { plan: 'pro', customer: `cus_${ws}`, subscription: `sub_${ws}`, periodEnd: '2030-03-14T12:00:00Z' })
        await setPagesUsed(ws, 25)
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')

        await expectPlan(page, 'Pro', '25', '475 of 500')
        await expect(page.getByText(NOTICE)).toBeVisible()
        await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(0)
        await expect(yourPlan(page)).not.toContainText('ends on')
        await checkSideScroll(page)
      })

      test('an owner on Pro set to end sees the date it ends', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        await setPlan(ws, { plan: 'pro', customer: `cus_${ws}`, subscription: `sub_${ws}`, periodEnd: '2030-03-14T12:00:00Z', cancelAtPeriodEnd: true })
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')

        await expect(yourPlan(page)).toContainText('Your Pro plan ends on 14 March 2030.')
        await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeVisible()
        await checkSideScroll(page)
      })

      test('a member sees the plan and pages left, with neither button', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        const member = await createUser('Mia Member')
        await addMember(ws, member, 'member')
        await setPagesUsed(ws, 5)
        await signIn(context, baseURL!, member)
        await useWorkspace(context, baseURL!, ws)
        await page.goto('/billing')

        await expectPlan(page, 'Free', '5', '15 of 20')
        await expect(page.getByText(NOTICE)).toBeVisible()
        await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Manage or cancel' })).toHaveCount(0)
        await checkSideScroll(page)
      })

      test('Upgrade sends the browser to the URL the route returned', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        const sent = await interceptBillingCall(page, '/api/billing/checkout', { status: 200, body: { url: CHECKOUT_URL } })
        await stubHostedPage(context, CHECKOUT_URL)
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')

        await page.getByRole('button', { name: 'Upgrade' }).click()

        await page.waitForURL(CHECKOUT_URL)
        expect(sent).toEqual([{ workspaceId: ws }])
      })

      test('Manage or cancel sends the browser to the URL the route returned', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        await setPlan(ws, { plan: 'pro', customer: `cus_${ws}` })
        const sent = await interceptBillingCall(page, '/api/billing/portal', { status: 200, body: { url: PORTAL_URL } })
        await stubHostedPage(context, PORTAL_URL)
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')

        await page.getByRole('button', { name: 'Manage or cancel' }).click()

        await page.waitForURL(PORTAL_URL)
        expect(sent).toEqual([{ workspaceId: ws }])
      })

      test('a refused Upgrade shows the error on the page and leaves the plan as it was', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        await personalWorkspace(owner, 'Acme books')
        await interceptBillingCall(page, '/api/billing/checkout', { status: 500, body: { error: 'Checkout could not be opened. Try again.' } })
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')

        await page.getByRole('button', { name: 'Upgrade' }).click()

        await expect(page.getByRole('main').getByRole('alert')).toHaveText('Checkout could not be opened. Try again.')
        await expectPlan(page, 'Free', '0', '20 of 20')
        await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
        await expect(page).toHaveURL(/\/billing$/)
        await checkSideScroll(page)
      })

      test('a Manage or cancel that cannot reach the server shows an error and leaves the plan as it was', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        await setPlan(ws, { plan: 'pro', customer: `cus_${ws}` })
        await page.route('**/api/billing/portal', (route) => route.abort())
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')

        await page.getByRole('button', { name: 'Manage or cancel' }).click()

        await expect(page.getByRole('main').getByRole('alert')).toHaveText('That did not work. Check your connection and try again.')
        await expectPlan(page, 'Pro', '0', '500 of 500')
      })

      test('a signed fixture event posted to the webhook changes what the page shows', async ({ page, context, baseURL, request }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        await setPagesUsed(ws, 30)
        await signIn(context, baseURL!, owner)
        await page.goto('/billing')
        await expectPlan(page, 'Free', '30', '0 of 20')

        expect((await postSubscriptionUpdated(request, { ws })).status()).toBe(200)
        await page.reload()
        await expectPlan(page, 'Pro', '30', '470 of 500')
        await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeVisible()
        await expect(yourPlan(page)).not.toContainText('ends on')

        // 2030-03-17, in Unix seconds.
        expect((await postSubscriptionUpdated(request, { ws, cancelAtPeriodEnd: true, periodEnd: 1_900_000_000 })).status()).toBe(200)
        await page.reload()
        await expectPlan(page, 'Pro', '30', '470 of 500')
        await expect(yourPlan(page)).toContainText('Your Pro plan ends on 17 March 2030.')

        expect((await postSubscriptionDeleted(request, { ws })).status()).toBe(200)
        await page.reload()
        await expectPlan(page, 'Free', '30', '0 of 20')
        await expect(page.getByRole('button', { name: 'Upgrade' })).toBeVisible()
        await checkSideScroll(page)
      })

      test('after returning from Checkout, the page picks up the new plan by itself and stops', async ({ page, context, baseURL, request }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        const reads = countPlanReads(page)
        await signIn(context, baseURL!, owner)
        await page.goto('/billing?checkout=success')
        await expect(figure(page, 'Current plan')).toHaveText('Free')

        expect((await postSubscriptionUpdated(request, { ws })).status()).toBe(200)

        await expectPlan(page, 'Pro', '0', '500 of 500')
        await expect(page.getByRole('button', { name: 'Manage or cancel' })).toBeVisible()
        await expect(page.getByText(STILL_FREE)).toHaveCount(0)

        const afterUpgrade = reads.count
        await page.waitForTimeout(2_500)
        expect(reads.count).toBe(afterUpgrade)
        await checkSideScroll(page)
      })

      test('after returning from Checkout, it re-reads every 2 seconds for 20 seconds, then says the plan will update', async ({
        page,
        context,
        baseURL,
      }) => {
        const owner = await createUser('Olivia Owner')
        await personalWorkspace(owner, 'Acme books')
        const reads = countPlanReads(page)
        await signIn(context, baseURL!, owner)
        await page.clock.install()
        await page.goto('/billing?checkout=success')
        await expect(figure(page, 'Current plan')).toHaveText('Free')
        await expect(page.getByRole('button', { name: 'Upgrade' })).toBeDisabled()

        await page.clock.runFor(2_000)
        await expect.poll(() => reads.count).toBe(1)
        await page.clock.runFor(16_000)
        await expect.poll(() => reads.count).toBe(9)
        await expect(page.getByText(STILL_FREE)).toHaveCount(0)

        await page.clock.runFor(2_000)
        await expect.poll(() => reads.count).toBe(10)
        await expect(page.getByText(STILL_FREE)).toBeVisible()
        await expect(figure(page, 'Current plan')).toHaveText('Free')
        await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()

        await page.clock.runFor(20_000)
        await expect(page.getByText(STILL_FREE)).toBeVisible()
        expect(reads.count).toBe(10)
        await checkSideScroll(page)
      })

      test('a re-read that fails does not stop the others, and the page still says the plan will update', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        await personalWorkspace(owner, 'Acme books')
        await page.route('**/rest/v1/workspaces*', (route) => route.abort())
        await signIn(context, baseURL!, owner)
        await page.clock.install()
        await page.goto('/billing?checkout=success')
        await expect(figure(page, 'Current plan')).toHaveText('Free')

        // Longer than 20 seconds: the Supabase client backs off and retries a read that fails.
        await page.clock.runFor(60_000)

        await expect(page.getByText(STILL_FREE)).toBeVisible()
        await expect(figure(page, 'Current plan')).toHaveText('Free')
      })

      test('returning from a cancelled Checkout shows the plan as it is, with no message and no timer', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        await personalWorkspace(owner, 'Acme books')
        const reads = countPlanReads(page)
        await signIn(context, baseURL!, owner)
        await page.clock.install()
        await page.goto('/billing')
        await expect(figure(page, 'Current plan')).toHaveText('Free')
        await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()

        await page.clock.runFor(30_000)

        await expect(page.getByText(STILL_FREE)).toHaveCount(0)
        expect(reads.count).toBe(0)
      })

      test('returning from Checkout already on Pro runs no timer', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        await setPlan(ws, { plan: 'pro', customer: `cus_${ws}` })
        const reads = countPlanReads(page)
        await signIn(context, baseURL!, owner)
        await page.clock.install()
        await page.goto('/billing?checkout=success')
        await expect(figure(page, 'Current plan')).toHaveText('Pro')

        await page.clock.runFor(30_000)

        await expect(page.getByText(STILL_FREE)).toHaveCount(0)
        expect(reads.count).toBe(0)
      })

      test('a reload after returning from Checkout does not start the re-reads again', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        await personalWorkspace(owner, 'Acme books')
        await signIn(context, baseURL!, owner)
        await page.goto('/billing?checkout=success')
        await expect(page).toHaveURL(/\/billing$/)
        await page.reload()
        await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
      })

      test('the signed-in navigation opens the page for an owner and a member', async ({ page, context, baseURL }) => {
        const owner = await createUser('Olivia Owner')
        const ws = await personalWorkspace(owner, 'Acme books')
        const member = await createUser('Mia Member')
        await addMember(ws, member, 'member')

        await signIn(context, baseURL!, owner)
        await page.goto('/documents')
        await switcher(page).click()
        await page.getByRole('menuitem', { name: 'Billing' }).click()
        await expect(page).toHaveURL(/\/billing$/)
        await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible()

        await context.clearCookies()
        await signIn(context, baseURL!, member)
        await useWorkspace(context, baseURL!, ws)
        await page.goto('/documents')
        await switcher(page).click()
        await page.getByRole('menuitem', { name: 'Billing' }).click()
        await expect(page).toHaveURL(/\/billing$/)
        await expect(figure(page, 'Current plan')).toHaveText('Free')
      })
    })
  }

  test.describe('the routes themselves, which refuse before any Stripe call', () => {
    test('a signed-out visitor to the page goes to sign-in', async ({ page }) => {
      await page.goto('/billing')
      await expect(page).toHaveURL(/\/sign-in\?next=%2Fbilling$/)
    })

    test('checkout and portal answer 401 with no session', async ({ request }) => {
      for (const path of ['/api/billing/checkout', '/api/billing/portal']) {
        const response = await request.post(path, { data: { workspaceId: '00000000-0000-0000-0000-000000000000' } })
        expect(response.status()).toBe(401)
        expect(await response.json()).toEqual({ error: 'Sign in to manage billing.' })
      }
    })

    test('checkout and portal answer 403 to a member, and to a body that names no workspace', async ({ context, baseURL }) => {
      const owner = await createUser('Olivia Owner')
      const ws = await personalWorkspace(owner, 'Acme books')
      await setPlan(ws, { plan: 'free', customer: `cus_${ws}` })
      const member = await createUser('Mia Member')
      await addMember(ws, member, 'member')
      await signIn(context, baseURL!, member)
      for (const path of ['/api/billing/checkout', '/api/billing/portal']) {
        expect((await context.request.post(path, { data: { workspaceId: ws } })).status()).toBe(403)
        expect((await context.request.post(path, { data: 'not json' })).status()).toBe(403)
      }
    })

    test('checkout answers 409 on Pro, and the portal 409 with no Stripe customer', async ({ context, baseURL }) => {
      const owner = await createUser('Olivia Owner')
      const ws = await personalWorkspace(owner, 'Acme books')
      await signIn(context, baseURL!, owner)

      expect((await context.request.post('/api/billing/portal', { data: { workspaceId: ws } })).status()).toBe(409)

      await setPlan(ws, { plan: 'pro', customer: `cus_${ws}` })
      expect((await context.request.post('/api/billing/checkout', { data: { workspaceId: ws } })).status()).toBe(409)
    })

    test('the webhook answers 400, changing nothing, to a missing or wrong signature', async ({ page, context, baseURL, request }) => {
      const owner = await createUser('Olivia Owner')
      const ws = await personalWorkspace(owner, 'Acme books')
      const object = subscriptionFixture({ ws })

      const unsigned = await request.post('/api/stripe/webhook', {
        data: JSON.stringify({ id: 'evt_unsigned', object: 'event', type: 'customer.subscription.updated', data: { object } }),
      })
      expect(unsigned.status()).toBe(400)
      expect((await postEvent(request, 'customer.subscription.updated', object, 'whsec_someone_else')).status()).toBe(400)

      await signIn(context, baseURL!, owner)
      await page.goto('/billing')
      await expect(figure(page, 'Current plan')).toHaveText('Free')
    })

    test('the webhook acknowledges another event type, and one naming no known workspace, without changing the page', async ({
      page,
      context,
      baseURL,
      request,
    }) => {
      const owner = await createUser('Olivia Owner')
      const ws = await personalWorkspace(owner, 'Acme books')

      expect((await postEvent(request, 'invoice.paid', subscriptionFixture({ ws }))).status()).toBe(200)
      expect((await postSubscriptionUpdated(request, { ws: '00000000-0000-0000-0000-000000000000' })).status()).toBe(200)

      await signIn(context, baseURL!, owner)
      await page.goto('/billing')
      await expect(figure(page, 'Current plan')).toHaveText('Free')
    })
  })
})
