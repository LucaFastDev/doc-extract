import { expect, test, type Locator, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { addMember, personalWorkspace, switcher } from './support/workspace'

// Dialog focus, long addresses and a user with no workspace (PRD US-8.1 AC-3, US-8.2), at phone
// width (OQ-40).
test.use({ viewport: { width: 360, height: 740 } })

const LONG_ADDRESS = 'pending.person.with.a.long.address@example-company.test.x'

async function expectInside(page: Page, dialog: Locator, inner: Locator) {
  const outer = (await dialog.boundingBox())!
  const box = (await inner.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(outer.x)
  expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width)
  expect(box.y).toBeGreaterThanOrEqual(outer.y)
  expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
}

async function expectContentInside(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible()
  const viewport = page.viewportSize()!
  const outer = (await dialog.boundingBox())!
  expect(outer.x).toBeGreaterThanOrEqual(0)
  expect(outer.x + outer.width).toBeLessThanOrEqual(viewport.width)
  // Nothing inside is wider than the dialog's own box.
  const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  for (const part of await dialog.locator('h2, p, label, input, button').all()) {
    if (await part.isVisible()) await expectInside(page, dialog, part)
  }
}

for (const [name, open] of [
  [
    'Create workspace',
    async (page: Page) => {
      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Create workspace' }).click()
    },
  ],
  [
    'Rename workspace',
    async (page: Page) => {
      await switcher(page).click()
      await page.getByRole('menuitem', { name: 'Rename workspace' }).click()
    },
  ],
] as const) {
  test(`focus returns to the switcher when the ${name} dialog closes by submit and by Escape`, async ({
    page,
    context,
    baseURL,
  }) => {
    const user = await createUser()
    await signIn(context, baseURL!, user)
    await page.goto('/documents')
    const dialog = page.getByRole('dialog', { name })

    await open(page)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(switcher(page)).toBeFocused()

    await open(page)
    await dialog.getByLabel('Name').fill(`${name} done`)
    await dialog.getByRole('button', { name: name === 'Create workspace' ? 'Create' : 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(switcher(page)).toHaveAccessibleName(`Workspace: ${name} done`)
    await expect(switcher(page)).toBeFocused()
  })
}

test('the invitation link dialog keeps a long address inside the dialog at 360px', async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await createUser('Olivia Owner')
  await personalWorkspace(owner, 'Acme books')
  await signIn(context, baseURL!, owner)
  await page.goto('/members')

  await page.getByRole('button', { name: 'Invite' }).click()
  await page.getByRole('dialog', { name: 'Invite someone' }).getByLabel('Email address').fill(LONG_ADDRESS)
  await page.getByRole('dialog', { name: 'Invite someone' }).getByRole('button', { name: 'Create link' }).click()

  const shown = page.getByRole('dialog', { name: 'Invitation link' })
  await expect(shown).toContainText(LONG_ADDRESS)
  await expect(shown.getByLabel('Link')).toBeVisible()
  await expectContentInside(page, shown)
})

test('the remove-member confirmation keeps a long address inside the dialog at 360px', async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const member = await createUser('Temporary Name')
  await sql('update public.profiles set display_name = null, email = $2 where id = $1', [member.id, LONG_ADDRESS])
  await addMember(ws, member, 'member')
  await signIn(context, baseURL!, owner)
  await page.goto('/members')

  await page.getByRole('button', { name: `Change ${LONG_ADDRESS}` }).click()
  await page.getByRole('menuitem', { name: 'Remove from workspace' }).click()

  const confirm = page.getByRole('dialog', { name: `Remove ${LONG_ADDRESS}?` })
  await expect(confirm).toContainText('They lose access to Acme books at once.')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(confirm.getByRole('button', { name: 'Remove' })).toBeVisible()
  await expectContentInside(page, confirm)
})

test('a user removed from their only workspace sees how to create one, and creates it', async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createUser()
  await signIn(context, baseURL!, user)
  await sql('delete from public.workspace_members where user_id = $1', [user.id])

  for (const path of ['/documents', '/members']) {
    await page.goto(path)
    await expect(page.getByRole('main')).toContainText('You are not in any workspace.')
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
    await expect(switcher(page)).toHaveCount(0)
  }

  await page.goto('/documents')
  await page.reload()
  await page.getByRole('main').getByRole('button', { name: 'Create workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create workspace' })
  await dialog.getByLabel('Name').fill('Fresh start')
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(dialog).toBeHidden()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Fresh start')
  await expect(page.getByText('No documents in Fresh start yet.')).toBeVisible()
  await expect(page.getByText('You are not in any workspace.')).toHaveCount(0)
})
