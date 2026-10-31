import { expect, test } from '@playwright/test'

test('the home page loads', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  await expect(page).toHaveTitle('doc-extract')
  await expect(page.getByRole('heading', { level: 1, name: 'doc-extract' })).toBeVisible()
})

test('the home page fits a 360px-wide phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/')
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(360)
})
