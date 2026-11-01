import { expect, test } from '@playwright/test'
import { adminClient, createUser, signIn, sql } from './support/auth'
import { pdfFile } from './support/files'
import { seedDocument } from './support/review'
import { personalWorkspace } from './support/workspace'

// Issue #61, criterion 1: DELETE /api/workspaces/[id] answers 404 to an id that is not a UUID and 204
// on success. The same UUID in capitals passes the handler's check, and is_owner, as a valid id.
// Storage's listing then finds the workspace's objects under the capitalised folder, its removal
// finds nothing at that exact path, and the handler answers 500 however many times it is run.

test('an owner deleting a workspace with its id in capitals gets 204, and the row and files are gone', async ({ page, context, baseURL }) => {
  const owner = await createUser()
  const ws = await personalWorkspace(owner, 'Capitals')
  const doc = await seedDocument(owner, { file: await pdfFile('kept.pdf', 1) })
  await signIn(context, baseURL!, owner)
  await page.goto('/documents')

  const response = await page.request.delete(`/api/workspaces/${ws.toUpperCase()}`)

  expect(response.status()).toBe(204)
  expect(await sql('select 1 from public.workspaces where id = $1', [ws])).toEqual([])
  const { data, error } = await adminClient().storage.from('documents').list(`${ws}/${doc}`)
  expect(error).toBeNull()
  expect(data).toEqual([])
})
