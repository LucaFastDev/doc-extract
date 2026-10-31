// e2e/qa-realtime-auth.spec.ts
import { expect, test } from '@playwright/test'
import { createUser, signIn, sql } from './support/auth'

// QA PR #21: the document list's Realtime subscription must be made as the signed-in user. When
// the channel joins without the user's access token, Realtime refuses the postgres_changes
// subscription ("invalid column for filter workspace_id", as anon cannot read documents), the
// page still reports itself subscribed, and no status change reaches it (PRD US-10.1 AC-2).
test.use({ viewport: { width: 360, height: 740 } })
test.describe.configure({ retries: 0 })

test('the documents channel joins as the user and a status change reaches the open list', async ({
  page,
  context,
  baseURL,
}) => {
  const joins: { token: boolean }[] = []
  const refusals: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const text = String(f.payload)
      if (!text.includes('"phx_join"') || !text.includes('realtime:documents:')) return
      const payload = JSON.parse(text)[4] as { access_token?: string }
      joins.push({ token: typeof payload.access_token === 'string' && payload.access_token.length > 0 })
    })
    ws.on('framereceived', (f) => {
      const text = String(f.payload)
      if (text.includes('"system"') && text.includes('"status":"error"')) refusals.push(text)
    })
  })

  const user = await createUser()
  const [{ workspace_id: ws }] = await sql<{ workspace_id: string }>(
    'select workspace_id from public.workspace_members where user_id = $1',
    [user.id],
  )
  const [doc] = await sql<{ id: string }>(
    `insert into public.documents (workspace_id, uploaded_by, status, file_name, mime_type, byte_size, page_count, storage_path)
     values ($1::uuid, $2, 'queued', 'Live.pdf', 'application/pdf', 100, 4, $1::text || '/x/original') returning id`,
    [ws, user.id],
  )
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Live.pdf', exact: true }) })
  await expect(row.getByRole('cell')).toHaveText(['Live.pdf', '', 'Queued', '4'])
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'subscribed')

  await sql("update public.documents set status = 'processing' where id = $1", [doc.id])
  await expect(row.getByRole('cell')).toHaveText(['Live.pdf', '', 'Processing', '4'], { timeout: 5000 })

  expect(refusals, 'Realtime refused the subscription').toEqual([])
  expect(joins.at(-1), 'the last documents channel join carried no access token').toEqual({ token: true })
})
