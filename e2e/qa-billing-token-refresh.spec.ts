import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { personalWorkspace } from './support/workspace'

// Issue #94's goal: "Give every call the billing page makes a time limit, so the page always comes back
// to a state where the owner can act." A plan read starts with the token refresh the Supabase client
// does when the access token has run out, and that call is outside the query's abort signal: when it
// never answers, the query never starts and readPlan never settles.

const CHECKING = 'Checking your plan…'
const STILL_FREE = 'Your payment went through. Your plan will update shortly.'
const ALREADY_PRO = 'This workspace is already on Pro.'
const never = () => new Promise<void>(() => {})

function currentPlan(page: Page) {
  return page.getByRole('region', { name: 'Your plan' }).locator('dl > div').filter({ hasText: 'Current plan' }).getByRole('definition')
}

/** The session in the browser's cookie runs out, as in a tab left open past the access token's life. */
async function expireSessionInBrowser(context: BrowserContext) {
  const cookies = await context.cookies()
  const auth = cookies.filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name))
  expect(auth.length).toBeGreaterThan(0)
  const session = JSON.parse(Buffer.from(auth.map((c) => c.value).join('').replace(/^base64-/, ''), 'base64url').toString())
  session.expires_at = Math.floor(Date.now() / 1000) - 60
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
  // Overwritten in place, never cleared: a read in the gap would go out with no session. expires_at
  // keeps its length, so the chunks stay as they are.
  const base = auth[0].name.replace(/\.\d+$/, '')
  const size = 3180
  const chunks: [string, string][] =
    value.length <= size
      ? [[base, value]]
      : Array.from({ length: Math.ceil(value.length / size) }, (_, i) => [`${base}.${i}`, value.slice(i * size, (i + 1) * size)])
  await context.addCookies(chunks.map(([name, v]) => ({ name, value: v, domain: auth[0].domain, path: auth[0].path, sameSite: 'Lax' as const })))
}

test.describe('a billing read whose token refresh never answers', () => {
  test('the read after a 409: within 25 seconds Upgrade is enabled, the error stays and the plan shows Free', async ({ page, context, baseURL }) => {
    test.setTimeout(60_000)
    const owner = await createUser('Olivia Owner')
    await personalWorkspace(owner, 'Acme books')
    await page.route('**/api/billing/checkout', (route) => route.fulfill({ status: 409, json: { error: ALREADY_PRO } }))
    await signIn(context, baseURL!, owner)
    const readOnMount = page.waitForResponse('**/rest/v1/rpc/get_page_allowance*')
    await page.goto('/billing')
    await readOnMount
    await expect(currentPlan(page)).toHaveText('Free')
    const upgrade = page.getByRole('button', { name: 'Upgrade' })
    await expect(upgrade).toBeEnabled()
    await page.route('**/auth/v1/token*', never)
    await expireSessionInBrowser(context)

    await upgrade.click()
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(ALREADY_PRO)

    await expect(upgrade).toBeEnabled({ timeout: 25_000 })
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(ALREADY_PRO)
    await expect(currentPlan(page)).toHaveText('Free')
  })

  test('the re-reads after a paid answer: within 50 seconds Checking your plan is gone, the payment message shows, Upgrade is enabled', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000)
    const owner = await createUser('Olivia Owner')
    const ws = await personalWorkspace(owner, 'Acme books')
    let answerReturn = () => {}
    const held = new Promise<void>((resolve) => {
      answerReturn = resolve
    })
    await page.route('**/api/billing/checkout-return', async (route) => {
      await held
      await route.fulfill({ status: 200, json: { paid: true } })
    })
    await signIn(context, baseURL!, owner)
    await page.goto(`/billing?checkout=success&workspace=${ws}&session_id=cs_test_return`)
    await expect(page.getByText(CHECKING)).toBeVisible()
    // The marker is spent, so the router's own request, which refreshes on the server, has finished.
    await page.waitForURL((url) => url.pathname === '/billing' && url.search === '')
    await page.route('**/auth/v1/token*', never)
    await expireSessionInBrowser(context)
    answerReturn()

    await expect(page.getByText(CHECKING)).toHaveCount(0, { timeout: 50_000 })
    await expect(page.getByText(STILL_FREE)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upgrade' })).toBeEnabled()
  })
})
