import { expect, test, type Page } from '@playwright/test'
import { addCookies, cookieJarClient, createUser, signIn, sql } from './support/auth'

// Sign-in (PRD US-9.1, OQ-21, OQ-34), at phone width (OQ-40).
test.use({ viewport: { width: 360, height: 740 } })

async function expectNoSideScroll(page: Page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(360)
}

test('a signed-out visitor of an app page is sent to sign-in, carrying the page as next', async ({ page }) => {
  await page.goto('/documents?status=failed')
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  expect(new URL(page.url()).searchParams.get('next')).toBe('/documents?status=failed')
})

test('the home page stays public', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL((url) => url.pathname === '/')
})

test('the sign-in page offers Google only, and fits a phone', async ({ page }) => {
  await page.goto('/sign-in')
  await expect(page.getByRole('heading', { name: 'Sign in to doc-extract' })).toBeVisible()
  // Within the page itself: the dev server adds its own tools button outside main.
  await expect(page.getByRole('main').getByRole('button')).toHaveText(['Continue with Google'])
  await expect(page.locator('input')).toHaveCount(0)
  await expectNoSideScroll(page)
})

test('Continue with Google goes to Google through Supabase Auth, returning to the callback with next', async ({
  page,
  baseURL,
}) => {
  // Google itself is never reached: the request to Supabase Auth is caught and answered here.
  let authorize: URL | undefined
  await page.route('**/auth/v1/authorize?**', async (route) => {
    authorize = new URL(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Google</p>' })
  })
  await page.goto('/sign-in?next=%2Fdocuments%3Fstatus%3Dfailed')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect.poll(() => authorize?.searchParams.get('provider')).toBe('google')
  const redirectTo = new URL(authorize!.searchParams.get('redirect_to') ?? '')
  expect(redirectTo.origin).toBe(new URL(baseURL!).origin)
  expect(redirectTo.pathname).toBe('/auth/callback')
  expect(redirectTo.searchParams.get('next')).toBe('/documents?status=failed')
  expect(authorize!.searchParams.get('code_challenge')).toBeTruthy()
})

test('after sign-in through the callback, the visitor lands on the page they first asked for', async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createUser()
  await page.goto('/documents?from=e2e')
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  const next = new URL(page.url()).searchParams.get('next')!

  // The same PKCE round trip as Google's, through the test-only email provider: a magic link whose
  // code /auth/callback exchanges with the verifier cookie the sign-in left in the browser.
  const callback = new URL('/auth/callback', baseURL)
  callback.searchParams.set('next', next)
  const { client, cookies } = cookieJarClient()
  const { error } = await client.auth.signInWithOtp({
    email: user.email,
    options: { shouldCreateUser: false, emailRedirectTo: callback.toString() },
  })
  expect(error).toBeNull()
  await addCookies(context, baseURL!, cookies())
  const [token] = await sql<{ token_hash: string }>(
    'select token_hash from auth.one_time_tokens where user_id = $1 order by created_at desc limit 1',
    [user.id],
  )
  const verify = new URL('/auth/v1/verify', process.env.NEXT_PUBLIC_SUPABASE_URL)
  verify.searchParams.set('token', token.token_hash)
  verify.searchParams.set('type', 'magiclink')
  verify.searchParams.set('redirect_to', callback.toString())
  await page.goto(verify.toString())

  await expect(page).toHaveURL(new URL('/documents?from=e2e', baseURL).toString())
  await expect(page.getByRole('button', { name: /Workspace: Personal/ })).toBeVisible()
})

test('a failed callback returns to sign-in with a message', async ({ page }) => {
  await page.goto('/auth/callback?code=not-a-code&next=%2Fdocuments')
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  // Within main: Next.js's route announcer is an alert too.
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Sign-in did not complete. Try again.')
})

test('a signed-in user sees their personal workspace, and signing out ends the session', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto('/documents')
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Workspace: Personal/ })).toBeVisible()
  await expectNoSideScroll(page)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/')
  await page.goto('/documents')
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
})

test('a signed-in user who opens sign-in goes on to next', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto('/sign-in?next=%2Fdocuments')
  await expect(page).toHaveURL((url) => url.pathname === '/documents')
})

test('a signed-in user whose next resolves to another host lands on the document list', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto('/sign-in?next=/.//evil.example/x')
  await expect(page).toHaveURL(new URL('/documents', baseURL).toString())
})
