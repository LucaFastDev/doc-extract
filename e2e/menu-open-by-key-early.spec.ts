import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'
import { openByPointer } from './support/menu'
import { addMember, personalWorkspace, roleOf, switcher } from './support/workspace'

// Issue #112: the menu library learns that the keyboard is in use from a keydown listener on the
// document, added in an effect once the page is hydrated. On a slow machine the key that opens a menu
// can reach the button before that effect has run, and the menu then opened with focus on itself, not
// on its first item. The timing is replaced here by holding that listener back, so the press always
// comes first. React's own document listeners take a boolean, so they are not held.
async function holdKeyboardListenerUntilMenuOpens(page: Page) {
  await page.addInitScript(() => {
    const add = document.addEventListener.bind(document)
    document.addEventListener = ((type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
      const held = type === 'keydown' && typeof options === 'object' && options.capture && !document.querySelector('[role="menu"]')
      if (!held) add(type, listener, options)
    }) as typeof document.addEventListener
  })
}

/** Presses the key on the button until the menu opens. A press before the page is hydrated does nothing. */
async function openWithKey(page: Page, button: Locator, key: string) {
  await button.focus()
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await page.keyboard.press(key)
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 })
  }).toPass()
}

async function onDocuments(page: Page, context: BrowserContext, baseURL: string) {
  const user = await createUser()
  await sql(
    `with ws as (insert into public.workspaces (name, created_by) values ('Shared books', $1) returning id)
     insert into public.workspace_members (workspace_id, user_id, role) select id, $1, 'owner' from ws`,
    [user.id],
  )
  await signIn(context, baseURL, user)
  await page.goto('/documents')
  await expect(switcher(page)).toHaveAccessibleName('Workspace: Personal')
}

for (const [name, key] of [
  ['Enter', 'Enter'],
  ['Space', 'Space'],
  ['ArrowDown', 'ArrowDown'],
]) {
  test(`${name} before the keyboard listener is ready: focus lands on the first item`, async ({ page, context, baseURL }) => {
    await holdKeyboardListenerUntilMenuOpens(page)
    await onDocuments(page, context, baseURL!)

    await openWithKey(page, switcher(page), key)

    await expect(page.getByRole('menuitemradio', { name: 'Personal' })).toBeFocused()
  })
}

test('opened before the keyboard listener is ready: arrows move and Enter runs the item', async ({ page, context, baseURL }) => {
  await holdKeyboardListenerUntilMenuOpens(page)
  await onDocuments(page, context, baseURL!)

  await openWithKey(page, switcher(page), 'Enter')
  await expect(page.getByRole('menuitemradio', { name: 'Personal' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Shared books' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(switcher(page)).toHaveAccessibleName('Workspace: Shared books')
})

test('the member menu before the keyboard listener is ready: focus lands on Make owner, and Enter runs it', async ({
  page,
  context,
  baseURL,
}) => {
  await holdKeyboardListenerUntilMenuOpens(page)
  const owner = await createUser('Olivia Owner')
  const ws = await personalWorkspace(owner, 'Acme books')
  const member = await createUser('Mia Member')
  await addMember(ws, member, 'member')
  await signIn(context, baseURL!, owner)
  await page.goto('/members')

  await openWithKey(page, page.getByRole('button', { name: 'Change Mia Member' }), 'Enter')
  await expect(page.getByRole('menuitem', { name: 'Make owner' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('listitem', { name: 'Mia Member' })).toHaveText(/Owner$/)
  expect(await roleOf(ws, member)).toBe('owner')
})

test('opened with the pointer: focus stays off the items', async ({ page, context, baseURL }) => {
  await onDocuments(page, context, baseURL!)
  const personal = page.getByRole('menuitemradio', { name: 'Personal' })

  await openByPointer(switcher(page), personal)

  await expect(page.getByRole('menu')).toBeFocused()
  await expect(personal).not.toBeFocused()
})

test('opened by keyboard, then the pointer leaves an item: focus stays on the menu', async ({ page, context, baseURL }) => {
  await holdKeyboardListenerUntilMenuOpens(page)
  await onDocuments(page, context, baseURL!)
  const shared = page.getByRole('menuitemradio', { name: 'Shared books' })
  const personal = page.getByRole('menuitemradio', { name: 'Personal' })

  await openWithKey(page, switcher(page), 'Enter')
  await expect(personal).toBeFocused()
  await shared.hover()
  await expect(shared).toBeFocused()
  await page.getByText('Workspaces', { exact: true }).hover()

  await expect(page.getByRole('menu')).toBeFocused()
})

test('a pointer press after a key that opened nothing: focus stays off the items', async ({ page, context, baseURL }) => {
  await onDocuments(page, context, baseURL!)
  const personal = page.getByRole('menuitemradio', { name: 'Personal' })

  await openByPointer(switcher(page), personal)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(switcher(page)).toBeFocused()
  await page.keyboard.press('a')

  await openByPointer(switcher(page), personal)

  await expect(page.getByRole('menu')).toBeFocused()
  await expect(personal).not.toBeFocused()
})

test('a pointer press after a keyboard open: focus stays off the items', async ({ page, context, baseURL }) => {
  await onDocuments(page, context, baseURL!)
  const personal = page.getByRole('menuitemradio', { name: 'Personal' })

  await openWithKey(page, switcher(page), 'Enter')
  await expect(personal).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  await openByPointer(switcher(page), personal)

  await expect(page.getByRole('menu')).toBeFocused()
  await expect(personal).not.toBeFocused()
})
