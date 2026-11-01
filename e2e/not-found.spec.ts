import { expect, test } from '@playwright/test'

// Issue #66 criteria 4 and 5: an address that does not exist shows our not-found page, with status
// 404, to a signed-out visitor too, who is not sent to sign-in.

for (const [label, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport })

    test('a signed-out visit to an unknown address answers 404 and shows the not-found page', async ({ page }) => {
      const response = await page.goto('/this-does-not-exist')

      expect(response?.status()).toBe(404)
      expect(new URL(page.url()).pathname).toBe('/this-does-not-exist')
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await expect(page.getByText('This page does not exist or has moved.')).toBeVisible()
      const scroll = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth)
      await page.getByRole('link', { name: 'Go to the home page' }).click()
      await expect(page).toHaveURL((url) => url.pathname === '/')
    })
  })
}

test('a signed-out visit to a protected page still goes to sign-in', async ({ page }) => {
  await page.goto('/documents/some-id')
  const url = new URL(page.url())
  expect(url.pathname).toBe('/sign-in')
  expect(url.searchParams.get('next')).toBe('/documents/some-id')
})
