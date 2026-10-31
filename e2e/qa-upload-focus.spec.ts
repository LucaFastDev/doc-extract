// e2e/qa-upload-focus.spec.ts
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createUser, signIn } from './support/auth'
import { picker } from './support/files'

// QA PR #21: the upload control's "Choose files" must show where keyboard focus is (WCAG 2.4.7),
// like the app's other shadcn/ui buttons. The file input is visually hidden behind its label, so
// the label is what the user sees; it must look different while the input has keyboard focus.
test.use({ viewport: { width: 360, height: 740 } })

/** The control and 8px around it, so a ring or outline drawn outside its box is included. */
async function around(page: Page, control: Locator) {
  const box = (await control.boundingBox())!
  return page.screenshot({
    animations: 'disabled',
    clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 },
  })
}

test('Choose files shows a focus indicator when reached with the keyboard', async ({ page, context, baseURL }) => {
  const user = await createUser()
  await signIn(context, baseURL!, user)
  await page.goto('/documents')

  const control = page.getByText('Choose files', { exact: true })
  await expect(control).toBeVisible()
  const unfocused = await around(page, control)

  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    if (await picker(page).evaluate((el) => el === document.activeElement)) break
  }
  await expect(picker(page)).toBeFocused()

  const focused = await around(page, control)
  expect(focused.equals(unfocused), 'the focused control looks exactly like the unfocused one').toBe(false)
})
