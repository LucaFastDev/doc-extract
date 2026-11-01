import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { adminClient, createUser, signIn, sql, type TestUser } from './support/auth'
import { pngFile } from './support/files'
import { check, expectNoSideScroll, seedDocument } from './support/review'

// Milestone 10 (PRD F12 US-12.1 AC-3, F14, US-5.1 AC-8; Lead rulings 1 and 4 on #48): the AI
// budget line on the document list, the daily limit's notice, and the review screen of a document
// whose file a real purge-files run removed, at phone width and on a desktop. The spend rows and
// app_config are shared by every spec, so the budget specs run one at a time and put back what
// they changed; nothing else spends while they run, because extraction is paused.

const VIEWPORTS = [
  { name: 'at 360px', viewport: { width: 360, height: 740 } },
  { name: 'on a desktop', viewport: { width: 1280, height: 900 } },
]

const MONTH = "date_trunc('month', now() at time zone 'utc')::date"

// A viewer far from UTC, so the resume time is shown in their own time zone and locale.
const VIEWER = { locale: 'en-GB', timezoneId: 'Pacific/Auckland' }

/** Calls purge-files as the daily pg_cron job does, with the local CRON_SECRET from Vault. */
async function runPurge() {
  const [{ secret }] = await sql<{ secret: string }>("select decrypted_secret as secret from vault.decrypted_secrets where name = 'cron_secret'")
  const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/purge-files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
    body: '{}',
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** A queued document in the user's personal workspace, as submit-document leaves it. */
async function queuedDocument(user: TestUser, name: string): Promise<string> {
  const [{ workspace_id: ws }] = await sql<{ workspace_id: string }>('select workspace_id from public.workspace_members where user_id = $1', [user.id])
  const id = randomUUID()
  await sql(
    `insert into public.documents (id, workspace_id, uploaded_by, status, file_name, mime_type, byte_size, page_count, storage_path)
     values ($1, $2, $3, 'queued', $4, 'image/png', 16, 1, $5)`,
    [id, ws, user.id, name, `${ws}/${id}/original`],
  )
  return id
}

test.describe('the AI budget line', () => {
  test.describe.configure({ mode: 'serial' })
  test.use(VIEWER)

  let saved: { month: { spent_usd: string; reserved_usd: string } | null; dailyCap: number }

  test.beforeAll(async () => {
    const [month] = await sql<{ spent_usd: string; reserved_usd: string }>(
      `select spent_usd, reserved_usd from public.ai_spend_periods where period_start = ${MONTH}`,
    )
    const { data, error } = await adminClient().from('app_config').select('daily_cap_usd').eq('id', true).single()
    if (error) throw error
    saved = { month: month ?? null, dailyCap: data.daily_cap_usd }
    // The seeded spend: $1.234567 this month, nothing reserved.
    await sql(
      `insert into public.ai_spend_periods (period_start, cap_usd, spent_usd, reserved_usd) values (${MONTH}, 10, 1.234567, 0)
       on conflict (period_start) do update set spent_usd = 1.234567, reserved_usd = 0`,
    )
  })

  test.afterAll(async () => {
    if (saved.month) {
      await sql(`update public.ai_spend_periods set spent_usd = $1, reserved_usd = $2 where period_start = ${MONTH}`, [
        saved.month.spent_usd,
        saved.month.reserved_usd,
      ])
    } else {
      await sql(`delete from public.ai_spend_periods where period_start = ${MONTH}`)
    }
  })

  /** Sets the local daily cap through the service role; afterEach puts the saved one back. */
  async function setDailyCap(usd: number) {
    const { error } = await adminClient().from('app_config').update({ daily_cap_usd: usd }).eq('id', true)
    if (error) throw error
  }

  test.afterEach(async () => {
    await setDailyCap(saved.dailyCap)
  })

  /** The next UTC midnight, as hour and minute in the viewer's time zone and locale. */
  async function nextMidnightForViewer() {
    const [{ at }] = await sql<{ at: Date }>("select (date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc' as at")
    return new Intl.DateTimeFormat(VIEWER.locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: VIEWER.timezoneId }).format(at)
  }

  for (const { name, viewport } of VIEWPORTS) {
    test(`${name}: the document list shows this month's AI spend of the cap, and no limit reached`, async ({ page, context, baseURL }) => {
      await page.setViewportSize(viewport)
      const user = await createUser()
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      const budget = page.getByLabel('AI budget')
      await expect(budget).toHaveText('$1.23 of $10 used this month')
      // Beside the pages left, in the upload area.
      await expect(page.getByRole('region', { name: 'Upload documents' }).getByLabel('AI budget')).toBeVisible()
      await expect(page.getByText('AI limit is reached')).toHaveCount(0)
      await expectNoSideScroll(page)
    })

    test(`${name}: with the daily cap reached, the notice says so and when waiting documents resume`, async ({ page, context, baseURL }) => {
      await page.setViewportSize(viewport)
      await setDailyCap(0)
      const user = await createUser()
      await signIn(context, baseURL!, user)
      await page.goto('/documents')

      const time = await nextMidnightForViewer()
      await expect(page.getByLabel('AI budget')).toContainText('$1.23 of $10 used this month')
      await expect(page.getByText(`Today's AI limit is reached. Waiting documents resume at ${time}.`, { exact: true })).toBeVisible()
      await expectNoSideScroll(page)
    })
  }

  test('a document status change through Realtime fetches the budget again, without a reload', async ({ page, context, baseURL }) => {
    const user = await createUser()
    const id = await queuedDocument(user, `Waiting ${randomUUID().slice(0, 6)}.png`)
    await signIn(context, baseURL!, user)
    await page.goto('/documents')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'subscribed')
    await expect(page.getByLabel('AI budget')).toHaveText('$1.23 of $10 used this month')
    let loads = 0
    page.on('load', () => loads++)

    // The ceiling is reached and process-queue moves the document to waiting.
    await setDailyCap(0)
    await sql("update public.documents set status = 'waiting_budget', status_reason = 'Waiting for the daily ceiling.' where id = $1", [id])
    await expect(page.getByText(`Today's AI limit is reached. Waiting documents resume at ${await nextMidnightForViewer()}.`)).toBeVisible()
    expect(loads).toBe(0)
  })
})

test('anonymous visitors and the demo never ask for the budget', async ({ page, context, baseURL }) => {
  const asked: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('get_budget_status')) asked.push(request.url())
  })
  for (const path of ['/', '/demo', '/demo/invoice-total-mismatch']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
  }
  // Signed in, the demo still never asks; only the document list does.
  await signIn(context, baseURL!, await createUser())
  await page.goto('/demo/invoice-total-mismatch')
  await page.waitForLoadState('networkidle')
  expect(asked).toEqual([])
  await page.goto('/documents')
  await expect(page.getByLabel('AI budget')).toBeVisible()
  expect(asked.length).toBeGreaterThan(0)
})

for (const { name, viewport } of VIEWPORTS) {
  test.describe(name, () => {
    test.use({ viewport })

    test('after a purge run removes its file, the review screen still shows the fields, the checks and the file-deleted notice', async ({
      page,
      context,
      baseURL,
    }) => {
      const user = await createUser()
      const file = pngFile(`Purged ${name} ${randomUUID().slice(0, 6)}.png`)
      const id = await seedDocument(user, { file })
      await sql("update public.documents set created_at = now() - interval '8 days' where id = $1", [id])
      const [{ path }] = await sql<{ path: string }>('select storage_path as path from public.documents where id = $1', [id])

      const purge = await runPurge()
      expect(purge.status).toBe(200)
      expect(purge.body.files_removed).toBeGreaterThanOrEqual(1)
      const [doc] = await sql<{ deleted: boolean }>('select file_deleted_at is not null as deleted from public.documents where id = $1', [id])
      expect(doc.deleted).toBe(true)
      expect(await sql("select 1 from storage.objects where bucket_id = 'documents' and name = $1", [path])).toEqual([])

      await signIn(context, baseURL!, user)
      await page.goto(`/documents/${id}`)
      await expect(page.getByText('The file was deleted 7 days after upload')).toBeVisible()
      await expect(page.getByRole('region', { name: 'Document', exact: true })).toHaveCount(0)
      await expect(check(page, 'A2')).toHaveAttribute('data-status', 'fail')
      await expect(check(page, 'D2')).toHaveAttribute('data-status', 'fail')
      await expect(page.getByLabel('Subtotal', { exact: true })).toHaveValue('120.00')
      await expect(page.getByLabel('Vendor name', { exact: true })).toHaveValue('Acme Supplies Ltd')
      await expectNoSideScroll(page)
    })
  })
}
