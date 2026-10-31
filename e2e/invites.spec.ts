import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import {
  expectNoSideScroll,
  invite,
  personalWorkspace,
  roleOf,
  signInThroughCallback,
  switcher,
} from './support/workspace'

// Copy-link invitations (PRD US-8.2 AC-1 to AC-3, OQ-18, OQ-19), at phone width (OQ-40).
test.use({ viewport: { width: 360, height: 740 } })

function sha256(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

test('an owner creates an invitation and copies its link, which is shown once', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  const owner = await createUser('Olivia Owner')
  await personalWorkspace(owner, 'Olivia books')
  await signIn(context, baseURL!, owner)
  await page.goto('/documents')

  await switcher(page).click()
  await page.getByRole('menuitem', { name: 'Members' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/members')
  await page.getByRole('button', { name: 'Invite' }).click()

  const form = page.getByRole('dialog', { name: 'Invite someone' })
  await form.getByLabel('Email address').fill('New.Person@Example.test')
  await expect(form.getByRole('radio', { name: /^Member/ })).toBeChecked()
  await form.getByRole('radio', { name: /^Owner/ }).click()
  await expectNoSideScroll(page)
  await form.getByRole('button', { name: 'Create link' }).click()

  const shown = page.getByRole('dialog', { name: 'Invitation link' })
  await expect(shown).toContainText('new.person@example.test')
  await expect(shown).toContainText('no email is sent')
  const link = await shown.getByLabel('Link').inputValue()
  const url = new URL(link)
  expect(url.origin).toBe(new URL(baseURL!).origin)
  expect(url.pathname).toMatch(/^\/invite\/[0-9a-f]{64}$/)
  const token = url.pathname.split('/')[2]
  await expectNoSideScroll(page)

  await shown.getByRole('button', { name: 'Copy link' }).click()
  await expect(shown.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link)

  const rows = await sql<{ email: string; role: string; token_hash: string }>(
    'select email, role, token_hash from public.workspace_invites where invited_by = $1',
    [owner.id],
  )
  expect(rows).toEqual([{ email: 'new.person@example.test', role: 'owner', token_hash: sha256(token) }])

  await shown.getByRole('button', { name: 'Done' }).click()
  await expect(shown).toBeHidden()
  const pending = page.getByRole('region', { name: 'Pending invitations' })
  await expect(pending.getByRole('listitem', { name: 'new.person@example.test' })).toContainText('Owner')

  // Shown once: neither reopening the dialog nor reloading the page brings the link back.
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.getByRole('dialog', { name: 'Invite someone' }).getByLabel('Email address')).toHaveValue('')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(pending).toBeVisible()
  expect(await page.content()).not.toContain(token)
})

test('the invited user accepts and joins with the invited role, in that workspace', async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const invitee = await createUser('Ian Invitee')
  const token = await invite(owner, ws, invitee.email.toUpperCase(), 'member')

  await signIn(context, baseURL!, invitee)
  await page.goto(`/invite/${token}`)
  await expect(page.getByRole('heading', { name: 'Join a workspace' })).toBeVisible()
  await expect(page.getByRole('main')).toContainText(invitee.email)
  await expectNoSideScroll(page)
  await page.getByRole('button', { name: 'Accept invitation' }).click()

  await expect(page).toHaveURL((url) => url.pathname === '/documents')
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Acme books')
  expect(await roleOf(ws, invitee)).toBe('member')

  // Accepted once: the same link no longer works, and the role is unchanged.
  await page.goto(`/invite/${token}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText('no longer valid')
  expect(await roleOf(ws, invitee)).toBe('member')
})

test('an owner invitation makes the invited user an owner', async ({ page, context, baseURL }) => {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const invitee = await createUser('Ian Invitee')
  const token = await invite(owner, ws, invitee.email, 'owner')

  await signIn(context, baseURL!, invitee)
  await page.goto(`/invite/${token}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Acme books')
  expect(await roleOf(ws, invitee)).toBe('owner')
})

test('someone signed in with another address is told it is not for them, and nothing changes', async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const invitee = await createUser('Ian Invitee')
  const someoneElse = await createUser('Sam Else')
  const token = await invite(owner, ws, invitee.email, 'owner')

  await signIn(context, baseURL!, someoneElse)
  await page.goto(`/invite/${token}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()

  await expect(page.getByRole('main').getByRole('alert')).toContainText('This invitation is not for you')
  await expectNoSideScroll(page)
  expect(await roleOf(ws, someoneElse)).toBeNull()
  const [row] = await sql<{ accepted_at: Date | null }>(
    'select accepted_at from public.workspace_invites where token_hash = $1',
    [sha256(token)],
  )
  expect(row.accepted_at).toBeNull()
  await page.getByRole('link', { name: 'Go to your documents' }).click()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
})

for (const [state, spoil] of [
  ['expired', "update public.workspace_invites set expires_at = now() - interval '1 second' where token_hash = $1"],
  ['revoked', 'update public.workspace_invites set revoked_at = now() where token_hash = $1'],
] as const) {
  test(`the link of an invitation that was ${state} is no longer valid, and nothing changes`, async ({ page, context, baseURL }) => {
    const owner = await createUser('Olivia Owner')
    const ws = await personalWorkspace(owner, 'Acme books')
    const invitee = await createUser('Ian Invitee')
    const token = await invite(owner, ws, invitee.email, 'member')
    await sql(spoil, [sha256(token)])

    await signIn(context, baseURL!, invitee)
    await page.goto(`/invite/${token}`)
    await page.getByRole('button', { name: 'Accept invitation' }).click()
    await expect(page.getByRole('main').getByRole('alert')).toContainText('This invitation is no longer valid')
    expect(await roleOf(ws, invitee)).toBeNull()
  })
}

test('a link that was never issued is no longer valid', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, await createUser())
  await page.goto(`/invite/${'0'.repeat(64)}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText('This invitation is no longer valid')
})

test('a signed-out visitor of an invitation is sent to sign-in, and comes back to it', async ({
  page,
  context,
  baseURL,
}) => {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const invitee = await createUser('Ian Invitee')
  const token = await invite(owner, ws, invitee.email, 'member')

  await page.goto(`/invite/${token}`)
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  const next = new URL(page.url()).searchParams.get('next')!
  expect(next).toBe(`/invite/${token}`)
  expect(await roleOf(ws, invitee)).toBeNull()

  await signInThroughCallback(page, context, baseURL!, invitee, next)
  await expect(page).toHaveURL(new URL(`/invite/${token}`, baseURL).toString())
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Acme books')
  expect(await roleOf(ws, invitee)).toBe('member')
})
