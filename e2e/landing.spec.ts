import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'

// The landing page, privacy and terms (milestone 12, PRD F15 and US-18.3; issue #45 criteria 1, 2,
// 3, 6 and 7), signed out unless a spec says otherwise.

async function expectNoSideScroll(page: Page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(360)
}

test('a signed-out visitor sees the hero, the steps, the six types, the accuracy, the plans, the notice and the footer', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  const main = page.getByRole('main')

  await expect(main.getByRole('heading', { level: 1, name: 'Business documents in, checked data out' })).toBeVisible()
  await expect(main).toContainText('doc-extract reads invoices, receipts, bank statements, purchase orders, delivery notes and quotes with Claude.')
  await expect(main.getByRole('link', { name: 'Try the demo' })).toHaveAttribute('href', '/demo')
  await expect(main).toContainText('No sign-up. Sample documents, nothing saved.')
  await expect(main.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in')

  await expect(main.getByRole('heading', { name: 'How it works' })).toBeVisible()
  const steps = main.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 3 }) })
  await expect(main.locator('ol > li')).toHaveCount(3)
  await expect(main.locator('ol > li h3')).toHaveText(['Upload', 'Check', 'Approve and export'])
  await expect(steps.first()).toContainText('PDFs, phone photos or scans, up to 10 files at once and 10 pages per document.')

  await expect(main.getByRole('heading', { name: 'Six document types' })).toBeVisible()
  const types = page.locator('section[aria-labelledby="document-types"] li')
  await expect(types).toHaveText(['Invoices', 'Receipts', 'Bank statements', 'Purchase orders', 'Delivery notes', 'Quotes'])

  await expect(main.getByRole('heading', { name: 'Measured accuracy' })).toBeVisible()
  await expect(main).toContainText('Measured on a fixed set of 30 fictitious documents, 5 per type.')

  await expect(main.getByRole('heading', { name: 'Plans' })).toBeVisible()
  await expect(main).toContainText('Billing runs in Stripe test mode: no real card is ever charged.')
  await expect(main).toContainText('On this site each account can process 10 pages of its own documents in total, so the demo stays within its AI budget.')
  await expect(main).toContainText('Uploaded files are deleted 7 days after upload. The extracted data stays until you delete the document, the workspace or your account.')

  const footer = page.getByRole('contentinfo')
  await expect(footer.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', 'https://github.com/LucaFastDev/doc-extract')
  await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
  await expect(footer.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
})

test('the plans are the ones get_plan_limits gives: Free 20 pages for $0, Pro 500 pages for $19', async ({ page }) => {
  await page.goto('/')
  const plans = page.locator('section[aria-labelledby="plans"]')
  const free = plans.locator('div', { has: page.getByRole('heading', { name: 'Free', exact: true }) }).last()
  const pro = plans.locator('div', { has: page.getByRole('heading', { name: 'Pro', exact: true }) }).last()
  await expect(free).toContainText('20 pages a month per workspace')
  await expect(free).toContainText('$0')
  await expect(pro).toContainText('500 pages a month per workspace')
  await expect(pro).toContainText('$19 a month')
})

test('a signed-in user sees the landing page too, with no redirect', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto('/')
  await expect(page).toHaveURL((url) => url.pathname === '/')
  await expect(page.getByRole('heading', { level: 1, name: 'Business documents in, checked data out' })).toBeVisible()
})

test('Try the demo goes to the demo and a sample review screen is one click further, with no sign-in', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Try the demo' }).click()
  await expect(page).toHaveURL(/\/demo$/)
  await page.getByRole('link', { name: /Invoice with a wrong total/ }).click()
  await expect(page).toHaveURL(/\/demo\/invoice-total-mismatch$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('invoice-total-mismatch.pdf')
})

test('Sign in goes to the sign-in page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
})

test('privacy and terms are public, carry their copy, link to each other and back, and are linked from / and /sign-in', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/privacy')
  await expect(page).toHaveTitle('Privacy · doc-extract')
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible()
  const main = page.getByRole('main')
  await expect(main).toContainText('doc-extract is a demonstration project. This page says what it stores and who processes it.')
  await expect(main).toContainText('Sign-in is through Google. The app stores your name and email address from your Google account.')
  await expect(main).toContainText('Documents you upload are stored in Supabase and sent to Anthropic, which reads them with Claude to extract the data.')
  await expect(main).toContainText('Uploaded files are deleted 7 days after upload.')
  await expect(main).toContainText('Billing runs in Stripe test mode. No real card is charged, and Stripe holds any card details, not this app.')
  await expect(main).toContainText('The demo needs no account. Your edits and exports there stay in your browser and are never saved.')
  await expect(main).toContainText('The site is hosted on Vercel.')
  await expect(main.getByRole('link', { name: 'doc-extract home' })).toHaveAttribute('href', '/')

  await main.getByRole('link', { name: 'Terms' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/terms')
  await expect(page).toHaveTitle('Terms · doc-extract')
  await expect(page.getByRole('heading', { level: 1, name: 'Terms' })).toBeVisible()
  await expect(main).toContainText('doc-extract is a demonstration project, offered as is, with no warranty and no guarantee of availability.')
  await expect(main).toContainText('Do not upload documents you are not allowed to share, or anything you could not afford to lose.')
  await expect(main).toContainText('Check extracted values before you rely on them. The app flags what it can, but it can be wrong.')
  await expect(main).toContainText('Billing is in Stripe test mode: no real payment is taken and paying gives no rights to service.')
  await expect(main).toContainText('Accounts, workspaces and data may be removed at any time. You can delete your workspace or account yourself.')
  await expect(main).toContainText('The source code is MIT licensed; see the repository.')
  await expect(main.getByRole('link', { name: 'doc-extract home' })).toHaveAttribute('href', '/')

  await main.getByRole('link', { name: 'Privacy' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/privacy')

  await page.goto('/sign-in')
  await expect(page.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
  await expect(page.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
})

test.describe('at 360px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  for (const path of ['/', '/privacy', '/terms', '/sign-in']) {
    test(`${path} has no horizontal scroll`, async ({ page }) => {
      await page.goto(path)
      await expectNoSideScroll(page)
    })
  }
})
