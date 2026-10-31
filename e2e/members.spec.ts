import { expect, test, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import {
  addMember,
  expectNoSideScroll,
  invite,
  personalWorkspace,
  roleOf,
  useWorkspace,
} from './support/workspace'

// The members screen (PRD US-8.2 AC-4 to AC-6, OQ-20): an owner revokes invitations, removes
// members and changes roles, never leaving the workspace without an owner; a member sees no
// controls. At phone width (OQ-40).
test.use({ viewport: { width: 360, height: 740 } })

const LAST_OWNER = 'A workspace needs at least one owner. Make another member an owner first.'

function members(page: Page) {
  return page.getByRole('region', { name: 'Members' })
}

/** Opens a member's menu and picks an item, once any menu still closing has gone. */
async function choose(page: Page, name: string, item: string) {
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByRole('button', { name: `Change ${name}` }).click()
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click()
}

async function team() {
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const member = await createUser('Mia Member')
  await addMember(ws, member, 'member')
  return { owner, member, ws }
}

test('an owner sees members and pending invitations, and revokes one', async ({ page, context, baseURL }) => {
  const { owner, ws } = await team()
  const token = await invite(owner, ws, 'pending.person.with.a.long.address@example.test', 'member')
  await signIn(context, baseURL!, owner)
  await page.goto('/members')

  await expect(members(page).getByRole('listitem')).toHaveText([/Olivia Owner \(you\).*Owner/, /Mia Member.*Member/])
  const pending = page.getByRole('region', { name: 'Pending invitations' })
  const row = pending.getByRole('listitem', { name: 'pending.person.with.a.long.address@example.test' })
  await expect(row).toContainText('Member · expires')
  await expectNoSideScroll(page)

  await row.getByRole('button', { name: 'Revoke the invitation for pending.person.with.a.long.address@example.test' }).click()
  await expect(row).toBeHidden()
  await expect(pending).toContainText('No pending invitations.')
  const rows = await sql<{ revoked_at: Date | null }>(
    "select revoked_at from public.workspace_invites where workspace_id = $1 and token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex')",
    [ws, token],
  )
  expect(rows[0].revoked_at).not.toBeNull()
})

test('an owner removes a member, after confirming', async ({ page, context, baseURL }) => {
  const { owner, member, ws } = await team()
  await signIn(context, baseURL!, owner)
  await page.goto('/members')

  await choose(page, 'Mia Member', 'Remove from workspace')
  const confirm = page.getByRole('dialog', { name: 'Remove Mia Member?' })
  await expect(confirm).toContainText('They lose access to Acme books at once.')
  await expectNoSideScroll(page)
  await confirm.getByRole('button', { name: 'Remove' }).click()

  await expect(members(page).getByRole('listitem', { name: 'Mia Member' })).toBeHidden()
  await expect(members(page).getByRole('listitem')).toHaveCount(1)
  expect(await roleOf(ws, member)).toBeNull()
})

test('an owner makes a member an owner, and back', async ({ page, context, baseURL }) => {
  const { owner, member, ws } = await team()
  await signIn(context, baseURL!, owner)
  await page.goto('/members')
  const row = members(page).getByRole('listitem', { name: 'Mia Member' })

  await choose(page, 'Mia Member', 'Make owner')
  await expect(row).toContainText('Owner')
  expect(await roleOf(ws, member)).toBe('owner')
  // With two owners, the signed-in owner is no longer the last one and gets controls too.
  await expect(page.getByRole('button', { name: 'Change Olivia Owner' })).toBeVisible()

  await choose(page, 'Mia Member', 'Make member')
  await expect(row).not.toContainText('Owner')
  expect(await roleOf(ws, member)).toBe('member')
  expect(await roleOf(ws, owner)).toBe('owner')
})

test('the last owner cannot be removed or demoted: the page says why, and the database refuses it', async ({
  page,
  context,
  baseURL,
}) => {
  const { owner, ws } = await team()
  await signIn(context, baseURL!, owner)
  await page.goto('/members')

  const own = members(page).getByRole('listitem', { name: 'Olivia Owner' })
  await expect(own).toContainText('The only owner cannot be removed or made a member: a workspace needs at least one owner.')
  await expect(page.getByRole('button', { name: 'Change Olivia Owner' })).toHaveCount(0)
  await expectNoSideScroll(page)

  // A page that still shows a second owner, who has since been made a member elsewhere: the
  // controls are there, and the database refuses the change.
  const second = await createUser('Oscar Owner')
  await addMember(ws, second, 'owner')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Change Olivia Owner' })).toBeVisible()
  await sql("update public.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [
    ws,
    second.id,
  ])

  await choose(page, 'Olivia Owner', 'Make member')
  await expect(members(page).getByRole('alert')).toHaveText(LAST_OWNER)
  expect(await roleOf(ws, owner)).toBe('owner')

  await choose(page, 'Olivia Owner', 'Remove from workspace')
  await page.getByRole('dialog', { name: 'Remove Olivia Owner?' }).getByRole('button', { name: 'Remove' }).click()
  await expect(members(page).getByRole('alert')).toHaveText(LAST_OWNER)
  expect(await roleOf(ws, owner)).toBe('owner')
})

test('a member sees the members, and no invite, revoke, remove or role controls', async ({
  page,
  context,
  baseURL,
}) => {
  const { owner, member, ws } = await team()
  await invite(owner, ws, 'pending@example.test', 'member')
  await signIn(context, baseURL!, member)
  await useWorkspace(context, baseURL!, ws)
  await page.goto('/members')

  await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible()
  await expect(page.getByRole('main')).toContainText('People in Acme books.')
  await expect(members(page).getByRole('listitem')).toHaveText([/Olivia Owner.*Owner/, /Mia Member \(you\).*Member/])
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Pending invitations' })).toHaveCount(0)
  await expect(page.getByText('pending@example.test')).toHaveCount(0)
  await expect(page.getByText(/only owner cannot be removed/)).toHaveCount(0)
  await expectNoSideScroll(page)
})
