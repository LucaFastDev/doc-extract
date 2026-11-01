import { expect, test } from '@playwright/test'
import { createUser, signIn, sql, type TestUser } from './support/auth'
import { postSubscriptionUpdated } from './support/stripe'
import { addMember, personalWorkspace, switcher, useWorkspace } from './support/workspace'

// The billing page's re-reads and its payment message belong to the workspace that went to Checkout
// (Lead ruling 6 on #50: "No timer runs otherwise"; US-11.1 AC-8: only owners upgrade). Each test
// asserts the correct behaviour. No call reaches Stripe: Checkout is a stub page, and the return is
// the page's own URL.

const CHECKING = 'Checking your plan…'
const STILL_FREE = 'Your payment went through. Your plan will update shortly.'
const CHECKOUT_URL = 'https://checkout.stripe.test/session'

async function secondWorkspace(user: TestUser, name: string) {
  const [row] = await sql<{ id: string }>('insert into public.workspaces (name, created_by) values ($1, $2) returning id', [name, user.id])
  await addMember(row.id, user, 'owner')
  return row.id
}

test('a Checkout return while another tab has switched workspace says nothing about a payment on the unpaid one', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  test.setTimeout(60_000)
  const owner = await createUser('Olivia Owner')
  const paid = await personalWorkspace(owner, 'Paid workspace')
  await secondWorkspace(owner, 'Unpaid workspace')
  await signIn(context, baseURL!, owner)
  await useWorkspace(context, baseURL!, paid)

  // The first tab goes to Checkout for the paid workspace.
  await page.route('**/api/billing/checkout', (route) => route.fulfill({ status: 200, json: { url: CHECKOUT_URL } }))
  await context.route(CHECKOUT_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Hosted page</title>' }))
  await page.goto('/billing')
  await expect(page.getByRole('main')).toContainText('Paid workspace')
  await page.getByRole('button', { name: 'Upgrade' }).click()
  await page.waitForURL(CHECKOUT_URL)

  // Meanwhile a second tab switches to the other workspace.
  const otherTab = await context.newPage()
  await otherTab.goto('/billing')
  await switcher(otherTab).click()
  await otherTab.getByRole('menuitemradio', { name: 'Unpaid workspace' }).click()
  await expect(otherTab.getByRole('main')).toContainText('Unpaid workspace')
  await otherTab.close()

  // The payment completes for the paid workspace, and Stripe sends the first tab back.
  expect((await postSubscriptionUpdated(request, { ws: paid })).status()).toBe(200)
  await page.goto('/billing?checkout=success')

  // Whichever workspace the page now shows, it must not claim a payment for one that made none.
  const shown = page.getByRole('main')
  await expect(shown).toContainText(/Paid workspace|Unpaid workspace/)
  if ((await shown.innerText()).includes('Unpaid workspace')) {
    await expect(page.getByText(CHECKING)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
    // Longer than the 20 seconds of re-reads.
    await page.waitForTimeout(21_000)
    await expect(page.getByText(STILL_FREE)).toHaveCount(0)
  } else {
    await expect(page.getByRole('region', { name: 'Your plan' })).toContainText('Pro')
    await expect(page.getByText(STILL_FREE)).toHaveCount(0)
  }
})

test('a member, who cannot pay, is told nothing about a payment', async ({ page, context, baseURL }) => {
  test.setTimeout(60_000)
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const member = await createUser('Mia Member')
  await addMember(ws, member, 'member')
  await signIn(context, baseURL!, member)
  await useWorkspace(context, baseURL!, ws)

  await page.goto('/billing?checkout=success')
  await expect(page.getByRole('main')).toContainText('Acme books')

  await expect(page.getByText(CHECKING)).toHaveCount(0)
  // Longer than the 20 seconds of re-reads.
  await page.waitForTimeout(21_000)
  await expect(page.getByText(STILL_FREE)).toHaveCount(0)
})
