import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { adminClient, createUser, signIn, sql, type TestUser } from './support/auth'
import { pdfFile } from './support/files'
import { expectNoSideScroll, seedDocument } from './support/review'
import { addMember, personalWorkspace, switcher, useWorkspace } from './support/workspace'

// Deleting a workspace and an account through the UI (PRD F18, OQ-17, OQ-20, OQ-30, issue #61
// criteria 7, 8, 9 and 12, rulings 8 and 9), at phone width (OQ-40) and on the desktop. The server
// has no Stripe key and no workspace here has a subscription, so nothing can reach Stripe.

const FAILURE = 'This could not be deleted. Try again.'
const ACCOUNT_BODY =
  'This deletes your account and cannot be undone. You leave every workspace you share; documents you uploaded there stay, shown as uploaded by a deleted user.'

function workspaceBody(name: string) {
  return `This deletes ${name} for everyone: its documents, files, results, history, invitations and members. An active Pro subscription is cancelled at once. This cannot be undone.`
}

/** A second workspace the user owns. */
async function ownedWorkspace(user: TestUser, name: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `with ws as (insert into public.workspaces (name, created_by) values ($1, $2) returning id),
     m as (insert into public.workspace_members (workspace_id, user_id, role) select id, $2, 'owner' from ws)
     select id from ws`,
    [name, user.id],
  )
  return row.id
}

async function workspaceGone(id: string) {
  return (await sql('select 1 from public.workspaces where id = $1', [id])).length === 0
}

async function userGone(user: TestUser) {
  return (await sql('select 1 from auth.users where id = $1', [user.id])).length === 0
}

/** Opens the workspace dialog from the switcher's menu. */
async function openWorkspaceDialog(page: Page) {
  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
  return page.getByRole('dialog', { name: 'Delete workspace' })
}

function accountButton(page: Page) {
  return page.getByRole('banner').getByRole('button', { name: 'Delete account' })
}

async function openAccountDialog(page: Page) {
  await accountButton(page).click()
  return page.getByRole('dialog', { name: 'Delete your account' })
}

async function sessionCookies(context: BrowserContext) {
  return (await context.cookies()).filter((c) => c.name.startsWith('sb-'))
}

for (const [width, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`at ${width} width`, () => {
    test.use({ viewport })

    test('an owner sees Delete workspace right after Rename workspace; a member sees neither', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      const member = await createUser()
      const ws = await personalWorkspace(owner, `Team ${randomUUID().slice(0, 6)}`)
      await addMember(ws, member, 'member')

      await signIn(context, baseURL!, owner)
      await page.goto('/documents')
      await switcher(page).click()
      const items = await page.getByRole('menuitem').allInnerTexts()
      expect(items.at(-2)).toBe('Rename workspace')
      expect(items.at(-1)).toBe('Delete workspace')
      await page.keyboard.press('Escape')
      await context.clearCookies()

      await signIn(context, baseURL!, member)
      await useWorkspace(context, baseURL!, ws)
      await page.goto('/documents')
      await expect(switcher(page)).toHaveAccessibleName(/^Workspace: Team /)
      await switcher(page).click()
      await expect(page.getByRole('menuitem', { name: 'Create workspace' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Rename workspace' })).toHaveCount(0)
      await expect(page.getByRole('menuitem', { name: 'Delete workspace' })).toHaveCount(0)
    })

    test('the typed name gates the button, exactly, and cancelling changes nothing', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      const name = 'Acme Ltd books'
      const ws = await personalWorkspace(owner, name)
      await signIn(context, baseURL!, owner)
      await page.goto('/documents')

      const dialog = await openWorkspaceDialog(page)
      await expect(dialog.getByRole('heading', { name: 'Delete workspace' })).toBeVisible()
      await expect(dialog.getByText(workspaceBody(name), { exact: true })).toBeVisible()
      await expectNoSideScroll(page)
      const field = dialog.getByLabel(`Type ${name} to confirm`)
      const button = dialog.getByRole('button', { name: 'Delete workspace' })
      await expect(button).toBeDisabled()

      for (const wrong of ['Acme', 'acme ltd books', `${name} `, ` ${name}`, `${name}!`]) {
        await field.fill(wrong)
        await expect(button).toBeDisabled()
      }
      // Enter does not get past the gate either.
      await field.press('Enter')
      await expect(dialog).toBeVisible()

      await field.fill(name)
      await expect(button).toBeEnabled()
      await field.fill(`${name}x`)
      await expect(button).toBeDisabled()

      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      expect(await workspaceGone(ws)).toBe(false)
    })

    test('a very long workspace name stays inside both dialogs', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      const name = 'Unbroken'.repeat(13).slice(0, 100)
      await personalWorkspace(owner, name)
      await signIn(context, baseURL!, owner)
      await page.goto('/documents')

      const dialog = await openWorkspaceDialog(page)
      const field = dialog.getByLabel(`Type ${name} to confirm`)
      await expect(field).toBeVisible()
      // Waits out the dialog's opening animation, which scales its box.
      await expect
        .poll(async () => {
          const box = await dialog.boundingBox()
          return box!.x >= 0 && box!.x + box!.width <= viewport.width
        })
        .toBe(true)
      const box = await dialog.boundingBox()
      for (const inner of [dialog.getByText(workspaceBody(name), { exact: true }), dialog.getByText(`Type ${name} to confirm`)]) {
        const part = await inner.boundingBox()
        expect(part!.x + part!.width).toBeLessThanOrEqual(box!.x + box!.width)
      }
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()

      const account = await openAccountDialog(page)
      const note = account.getByText(/These workspaces have no other members/)
      await expect(note).toBeVisible()
      await page.waitForTimeout(300)
      const accountBox = await account.boundingBox()
      const noteBox = await note.boundingBox()
      expect(noteBox!.x + noteBox!.width).toBeLessThanOrEqual(accountBox!.x + accountBox!.width)
    })

    test('deleting the only workspace lands on the no-workspace screen', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      const name = 'Only one'
      const ws = await personalWorkspace(owner, name)
      await signIn(context, baseURL!, owner)
      await useWorkspace(context, baseURL!, ws)
      await page.goto('/members')

      const dialog = await openWorkspaceDialog(page)
      await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
      await dialog.getByRole('button', { name: 'Delete workspace' }).click()

      await expect(page.getByText('You are not in any workspace.')).toBeVisible()
      await expect(page).toHaveURL(/\/documents$/)
      await expect(switcher(page)).toHaveCount(0)
      expect(await workspaceGone(ws)).toBe(true)
      await expectNoSideScroll(page)
    })

    test('deleting one of two workspaces lands on the document list of the other, and a reload stays there', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      await personalWorkspace(owner, 'The other one')
      const name = `Doomed ${randomUUID().slice(0, 6)}`
      const ws = await ownedWorkspace(owner, name)
      await signIn(context, baseURL!, owner)
      await useWorkspace(context, baseURL!, ws)
      await page.goto('/members')
      await expect(switcher(page)).toHaveAccessibleName(`Workspace: ${name}`)

      let documentRequests = 0
      page.on('request', (request) => {
        if (request.isNavigationRequest() && new URL(request.url()).pathname === '/documents') documentRequests += 1
      })

      const dialog = await openWorkspaceDialog(page)
      await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
      await dialog.getByRole('button', { name: 'Delete workspace' }).click()

      await expect(switcher(page)).toHaveAccessibleName('Workspace: The other one')
      await expect(page).toHaveURL(/\/documents$/)
      await expect(page.getByText('No documents in The other one yet.')).toBeVisible()
      // A full navigation, not a client transition (ruling 9).
      expect(documentRequests).toBe(1)
      expect(await workspaceGone(ws)).toBe(true)

      await switcher(page).click()
      await expect(page.getByRole('menuitemradio')).toHaveText(['The other one'])
      await page.keyboard.press('Escape')

      // The cookie still names the workspace that is gone, and falls back.
      const cookie = (await context.cookies()).find((c) => c.name === 'workspace')
      expect(cookie?.value).toBe(ws)
      await page.reload()
      await expect(switcher(page)).toHaveAccessibleName('Workspace: The other one')
    })

    test('a second member of a deleted workspace falls back on their next page load', async ({ page, context, baseURL, browser }) => {
      const owner = await createUser()
      const member = await createUser()
      const loneMember = await createUser()
      const name = `Shared ${randomUUID().slice(0, 6)}`
      const ws = await personalWorkspace(owner, name)
      await personalWorkspace(member, 'Member home')
      await addMember(ws, member, 'member')
      await sql('delete from public.workspace_members where user_id = $1', [loneMember.id])
      await addMember(ws, loneMember, 'member')

      const memberContext = await browser.newContext({ baseURL, viewport })
      const loneContext = await browser.newContext({ baseURL, viewport })
      try {
        await signIn(memberContext, baseURL!, member)
        await useWorkspace(memberContext, baseURL!, ws)
        const memberPage = await memberContext.newPage()
        await memberPage.goto('/documents')
        await expect(switcher(memberPage)).toHaveAccessibleName(`Workspace: ${name}`)

        await signIn(loneContext, baseURL!, loneMember)
        await useWorkspace(loneContext, baseURL!, ws)
        const lonePage = await loneContext.newPage()
        await lonePage.goto('/documents')
        await expect(switcher(lonePage)).toHaveAccessibleName(`Workspace: ${name}`)

        await signIn(context, baseURL!, owner)
        await page.goto('/documents')
        const dialog = await openWorkspaceDialog(page)
        await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
        await dialog.getByRole('button', { name: 'Delete workspace' }).click()
        await expect(page.getByText('You are not in any workspace.')).toBeVisible()

        await memberPage.reload()
        await expect(switcher(memberPage)).toHaveAccessibleName('Workspace: Member home')
        await lonePage.reload()
        await expect(lonePage.getByText('You are not in any workspace.')).toBeVisible()
      } finally {
        await memberContext.close()
        await loneContext.close()
      }
    })

    test('deleting an account lands on /, signed out, and says which workspaces go with it', async ({ page, context, baseURL }) => {
      const user = await createUser()
      await personalWorkspace(user, 'Personal books')
      await ownedWorkspace(user, 'Side project')
      await signIn(context, baseURL!, user)
      await page.goto('/documents')
      await expectNoSideScroll(page)
      expect((await sessionCookies(context)).length).toBeGreaterThan(0)

      const dialog = await openAccountDialog(page)
      await expect(dialog.getByRole('heading', { name: 'Delete your account' })).toBeVisible()
      await expect(dialog.getByText(ACCOUNT_BODY, { exact: true })).toBeVisible()
      await expect(
        dialog.getByText('These workspaces have no other members and are deleted with all their data: Personal books, Side project.', { exact: true }),
      ).toBeVisible()
      await expectNoSideScroll(page)
      await dialog.getByRole('button', { name: 'Delete my account' }).click()

      await expect(page).toHaveURL(new RegExp(`^${baseURL}/?$`))
      await expect.poll(() => sessionCookies(context)).toEqual([])
      expect(await userGone(user)).toBe(true)

      await page.goto('/documents')
      await expect(page).toHaveURL(/\/sign-in\?next=%2Fdocuments$/)
    })

    test('a shared workspace with another owner adds no note, and the account can go', async ({ page, context, baseURL }) => {
      const owner = await createUser()
      const user = await createUser()
      const ws = await personalWorkspace(owner, 'Two owners')
      await sql('delete from public.workspace_members where user_id = $1', [user.id])
      await addMember(ws, user, 'owner')
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      const dialog = await openAccountDialog(page)
      const button = dialog.getByRole('button', { name: 'Delete my account' })
      await expect(button).toBeEnabled()
      await expect(dialog.getByText(/These workspaces have no other members/)).toHaveCount(0)
      await button.click()
      await expect(page).toHaveURL(new RegExp(`^${baseURL}/?$`))
      expect(await userGone(user)).toBe(true)
      expect(await workspaceGone(ws)).toBe(false)
    })

    test('a user with no workspace can reach Delete account', async ({ page, context, baseURL }) => {
      const user = await createUser()
      await sql('delete from public.workspace_members where user_id = $1', [user.id])
      await signIn(context, baseURL!, user)
      await page.goto('/documents')
      await expect(page.getByText('You are not in any workspace.')).toBeVisible()
      await expectNoSideScroll(page)

      const dialog = await openAccountDialog(page)
      await dialog.getByRole('button', { name: 'Delete my account' }).click()
      await expect(page).toHaveURL(new RegExp(`^${baseURL}/?$`))
      expect(await userGone(user)).toBe(true)
    })

    test('the refusal shows the sentence in the dialog as an alert, and nothing changes', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const teammate = await createUser()
      const ws = await personalWorkspace(user, 'Shared books')
      await addMember(ws, teammate, 'member')
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      const dialog = await openAccountDialog(page)
      await dialog.getByRole('button', { name: 'Delete my account' }).click()

      await expect(dialog.getByRole('alert')).toHaveText(
        'You are the only owner of Shared books, which still have other members. Make another member an owner of each, or delete it first.',
      )
      await expect(dialog).toBeVisible()
      await expectNoSideScroll(page)
      expect(await userGone(user)).toBe(false)
      expect(await workspaceGone(ws)).toBe(false)
      expect((await sessionCookies(context)).length).toBeGreaterThan(0)

      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
    })

    test('when the workspaces cannot be read, the account dialog says so and offers no delete button', async ({ page, context, baseURL }) => {
      const user = await createUser()
      await signIn(context, baseURL!, user)
      await page.goto('/documents')
      await expect(switcher(page)).toBeVisible()
      await page.route('**/rest/v1/workspace_members*', (route) => route.abort())

      const dialog = await openAccountDialog(page)
      // supabase-js retries a read that hits a network error, for several seconds, before it reports one.
      await expect(dialog.getByText("Couldn't load your workspaces. Try again.", { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect(dialog.getByRole('button', { name: 'Delete my account' })).toHaveCount(0)

      // Opening it again reads again.
      await page.unroute('**/rest/v1/workspace_members*')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      const again = await openAccountDialog(page)
      await expect(again.getByRole('button', { name: 'Delete my account' })).toBeEnabled()
    })

    test('a failure keeps either dialog open with the failure sentence as an alert', async ({ page, context, baseURL }) => {
      const user = await createUser()
      const name = 'Still here'
      const ws = await personalWorkspace(user, name)
      await signIn(context, baseURL!, user)
      await page.goto('/documents')
      await page.route('**/api/workspaces/*', (route) => route.fulfill({ status: 500, json: { error: 'no' } }))
      await page.route('**/api/account', (route) => route.fulfill({ status: 500, json: { error: 'no' } }))

      const dialog = await openWorkspaceDialog(page)
      await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
      await dialog.getByRole('button', { name: 'Delete workspace' }).click()
      await expect(dialog.getByRole('alert')).toHaveText(FAILURE)
      await expect(dialog).toBeVisible()
      expect(await workspaceGone(ws)).toBe(false)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()

      const account = await openAccountDialog(page)
      await account.getByRole('button', { name: 'Delete my account' }).click()
      await expect(account.getByRole('alert')).toHaveText(FAILURE)
      await expect(account).toBeVisible()
      expect(await userGone(user)).toBe(false)
    })

    test('after an account is deleted, its documents stay in a shared workspace, shown as uploaded by a deleted user', async ({ page, context, baseURL, browser }) => {
      const owner = await createUser()
      const leaver = await createUser()
      const ws = await personalWorkspace(owner, 'Team books')
      await addMember(ws, leaver, 'member')
      const id = await seedDocument(owner, { file: await pdfFile('kept.pdf', 1) })
      await sql('update public.documents set uploaded_by = $2 where id = $1', [id, leaver.id])

      const leaverContext = await browser.newContext({ baseURL, viewport })
      try {
        await signIn(leaverContext, baseURL!, leaver)
        const leaverPage = await leaverContext.newPage()
        await leaverPage.goto('/documents')
        const dialog = await openAccountDialog(leaverPage)
        await dialog.getByRole('button', { name: 'Delete my account' }).click()
        await expect(leaverPage).toHaveURL(new RegExp(`^${baseURL}/?$`))
      } finally {
        await leaverContext.close()
      }

      await signIn(context, baseURL!, owner)
      await page.goto(`/documents/${id}`)
      await expect(page.locator('li', { hasText: 'Uploaded by a deleted user' })).toBeVisible()
      const { data, error } = await adminClient().storage.from('documents').list(`${ws}/${id}`)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })
  })
}

// Issue #61 ruling 11: the refusal names every workspace, so with many of them the account dialog is
// taller than a phone window. It scrolls inside the window, so Cancel can still be reached and pressed.
test.describe('at 360x740', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test('Cancel can be reached and pressed in the account dialog when the refusal names 25 workspaces', async ({ page, context, baseURL }) => {
    const user = await createUser()
    const teammate = await createUser()
    const suffix = 'with a rather long descriptive name for the books'
    const first = await personalWorkspace(user, `Shared workspace number 01 ${suffix}`)
    await addMember(first, teammate, 'member')
    for (let n = 2; n <= 25; n++) {
      const id = await ownedWorkspace(user, `Shared workspace number ${String(n).padStart(2, '0')} ${suffix}`)
      await addMember(id, teammate, 'member')
    }
    await signIn(context, baseURL!, user)
    await page.goto('/documents')

    const dialog = await openAccountDialog(page)
    await dialog.getByRole('button', { name: 'Delete my account' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Shared workspace number 25')
    // Taller than the window, so only a scrolling dialog keeps Cancel within reach.
    expect(await dialog.evaluate((el) => el.scrollHeight)).toBeGreaterThan(740)
    const box = await dialog.boundingBox()
    expect(box!.height).toBeLessThanOrEqual(740)

    await dialog.getByRole('button', { name: 'Cancel' }).click({ timeout: 5_000 })
    await expect(dialog).toBeHidden()
    expect(await userGone(user)).toBe(false)
  })
})

test('the routes answer 401 with no session, past the proxy', async ({ playwright, baseURL }) => {
  const request = await playwright.request.newContext({ baseURL })
  try {
    const workspace = await request.delete(`/api/workspaces/${randomUUID()}`, { maxRedirects: 0 })
    expect(workspace.status()).toBe(401)
    const account = await request.delete('/api/account', { maxRedirects: 0 })
    expect(account.status()).toBe(401)
  } finally {
    await request.dispose()
  }
})
