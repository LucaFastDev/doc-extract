import { expect, test } from '@playwright/test'
import { createUser, signIn } from './support/auth'

// Accepted choice 15 on #48: the budget line and its notice are "in a group labelled 'AI budget'".
// A label on a <div> with no role names nothing: assistive technology gets no group and never reads
// "AI budget". The viewer's zoom controls show the form that works: role="group" aria-label="Zoom".
test('the budget line is a group named AI budget in the accessibility tree', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto('/documents')

  // Waits for the line itself, so a failure below is about the role and not about loading.
  await expect(page.getByText(/ used this month$/)).toBeVisible()
  const upload = page.getByRole('region', { name: 'Upload documents' })
  await expect(upload.getByRole('group', { name: 'AI budget' })).toContainText('used this month')
})
