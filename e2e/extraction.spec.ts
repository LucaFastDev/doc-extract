import { expect, test, type Page } from '@playwright/test'
import { MOCK_DOCUMENTS, type MockDocument } from './mock-claude/documents'
import { mockClaudePort } from './mock-claude/port'
import { createUser, signIn, sql } from './support/auth'
import { picker } from './support/files'
import { expectNoSideScroll } from './support/workspace'

// Extraction end to end (milestone 5, ARCHITECTURE.md sections 6.3, 6.4 and 9, PRD US-1.1 AC-7,
// US-1.2 AC-1 and AC-2, US-2.1 AC-6, US-10.1 AC-1 and AC-2, US-12.1 AC-2), at phone width
// (OQ-40). The real submit-document and process-queue run in the local stack, driven by the
// pg_cron job; Claude is the mock server in e2e/mock-claude/, which answers by the file's SHA-256.
// Every change reaches the open list through Realtime: no spec reloads the page.
//
// These run in the "extraction" project, after the upload specs, with extraction on
// (playwright.config.ts), and one at a time, because the daily ceiling and the pause they set are
// global to the stack.
test.use({ viewport: { width: 360, height: 740 } })
test.describe.configure({ mode: 'serial', timeout: 120_000 })

/** A cron tick, the function's work and Realtime, with room for a cold edge runtime. */
const PIPELINE = { timeout: 60_000 }

// A cold edge runtime loads a function's npm modules on its first request; one request each first.
test.beforeAll(async () => {
  test.setTimeout(120_000)
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  const submit = await fetch(new URL('/functions/v1/submit-document', base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(60_000),
  })
  expect(submit.status).toBe(400)
  // Without CRON_SECRET, process-queue answers 401 and processes nothing.
  const queue = await fetch(new URL('/functions/v1/process-queue', base), { method: 'POST', signal: AbortSignal.timeout(60_000) })
  expect(queue.status).toBe(401)
})

function row(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name })
}

/** Signs a new user in on the document list, and counts page loads from then on. */
async function openDocuments(page: Page, context: Parameters<typeof signIn>[0], baseURL: string) {
  const user = await createUser()
  await signIn(context, baseURL, user)
  await page.goto('/documents')
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'subscribed')
  const loads = { count: 0 }
  page.on('load', () => loads.count++)
  return { user, loads }
}

async function upload(page: Page, doc: MockDocument) {
  await picker(page).setInputFiles({ name: doc.name, mimeType: doc.mimeType, buffer: doc.buffer })
  await expect(row(page, doc.name)).toBeVisible()
}

async function documentOf(user: { id: string }, name: string) {
  const [doc] = await sql<{ id: string; status: string; doc_type: string | null; doc_type_source: string | null; pages_reserved: boolean }>(
    'select id, status, doc_type, doc_type_source, pages_reserved from public.documents where uploaded_by = $1 and file_name = $2',
    [user.id, name],
  )
  return doc
}

async function accountPagesUsed(user: { id: string }): Promise<number> {
  const [row] = await sql<{ pages_used: number }>('select pages_used from public.account_page_usage where user_id = $1', [user.id])
  return row?.pages_used ?? 0
}

test('an invoice reaches Needs review with type Invoice, detected by Claude', async ({ page, context, baseURL }) => {
  const doc = MOCK_DOCUMENTS.invoice
  const { user, loads } = await openDocuments(page, context, baseURL!)
  await upload(page, doc)

  await expect(row(page, doc.name).getByRole('cell')).toHaveText([doc.name, 'Invoice', 'Needs review', '1'], PIPELINE)
  expect(loads.count).toBe(0)
  await expectNoSideScroll(page)

  const stored = await documentOf(user, doc.name)
  expect(stored).toMatchObject({ status: 'needs_review', doc_type: 'invoice', doc_type_source: 'detected', pages_reserved: true })
  const checks = await sql('select check_id, status from public.check_results where document_id = $1 order by check_id', [stored.id])
  expect(checks).toEqual([
    { check_id: 'A1', status: 'pass' },
    { check_id: 'A2', status: 'pass' },
    { check_id: 'A3', status: 'pass' },
    { check_id: 'A4', status: 'skipped' },
    { check_id: 'D1', status: 'pass' },
    { check_id: 'D2', status: 'pass' },
    { check_id: 'U1', status: 'pass' },
  ])
  const [fields] = await sql<{ n: number }>('select count(*)::int as n from public.extraction_fields where document_id = $1', [stored.id])
  expect(fields.n).toBeGreaterThan(20)
  // Its page counts for good.
  expect(await accountPagesUsed(user)).toBe(1)

  // The request had the shape Lead ruling 1 on #24 sets: tool_choice auto, every tool strict.
  const seen = (await (await fetch(`http://127.0.0.1:${mockClaudePort()}/requests`)).json()) as {
    tool_choice: unknown
    tools: { name: string; strict: boolean }[]
    status: number
  }[]
  const call = seen.find((s) => s.status === 200 && s.tools.some((t) => t.name === 'record_invoice'))
  expect(call).toMatchObject({
    tool_choice: { type: 'auto' },
    tools: [
      { name: 'record_invoice', strict: true },
      { name: 'record_receipt', strict: true },
      { name: 'record_bank_statement', strict: true },
      { name: 'record_purchase_order', strict: true },
      { name: 'record_delivery_note', strict: true },
      { name: 'record_quote', strict: true },
      { name: 'record_not_supported', strict: true },
    ],
  })
})

// The other five types (milestone 6, PRD section 4.1, US-3.1, US-7.1 AC-5, OQ-16, OQ-29): each is
// detected, stored with its type's fields and checks, and shown on the list with its type.
const TYPES = [
  { doc: MOCK_DOCUMENTS.receipt, label: 'Receipt', docType: 'receipt', checks: ['A1', 'A2', 'A3', 'D1', 'U1'] },
  { doc: MOCK_DOCUMENTS.bankStatement, label: 'Bank statement', docType: 'bank_statement', checks: ['A1', 'A2', 'A3', 'D1', 'D2', 'U1'] },
  { doc: MOCK_DOCUMENTS.purchaseOrder, label: 'Purchase order', docType: 'purchase_order', checks: ['A1', 'A2', 'A3', 'D1', 'D2', 'U1'] },
  { doc: MOCK_DOCUMENTS.deliveryNote, label: 'Delivery note', docType: 'delivery_note', checks: ['A1', 'A2', 'D1', 'U1'] },
  { doc: MOCK_DOCUMENTS.quote, label: 'Quote', docType: 'quote', checks: ['A1', 'A2', 'A3', 'D1', 'D2', 'U1'] },
]

for (const { doc, label, docType, checks } of TYPES) {
  test(`a ${label.toLowerCase()} reaches Needs review with type ${label}`, async ({ page, context, baseURL }) => {
    const { user, loads } = await openDocuments(page, context, baseURL!)
    await upload(page, doc)

    await expect(row(page, doc.name).getByRole('cell')).toHaveText([doc.name, label, 'Needs review', '1'], PIPELINE)
    expect(loads.count).toBe(0)
    await expectNoSideScroll(page)

    const stored = await documentOf(user, doc.name)
    expect(stored).toMatchObject({ status: 'needs_review', doc_type: docType, doc_type_source: 'detected' })
    const rows = await sql<{ check_id: string; status: string }>(
      'select check_id, status from public.check_results where document_id = $1 order by check_id',
      [stored.id],
    )
    expect(rows).toEqual(checks.map((check_id) => ({ check_id, status: 'pass' })))
    const fields = await sql<{ path: string; extracted_value: string | null; flags: string[] }>(
      'select path, extracted_value, flags from public.extraction_fields where document_id = $1',
      [stored.id],
    )
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]))
    // Only a symbol several currencies use is printed on the receipt: the currency is a guess.
    expect(byPath.currency.flags.includes('currency_guessed')).toBe(docType === 'receipt')
    if (docType === 'receipt') expect(byPath.card_last4.extracted_value).toBe('4417')
    if (docType === 'bank_statement') expect(byPath.iban_last4.extracted_value).toBe('4321')
  })
}

test('a second invoice with the same vendor and number reaches Needs review too, flagged as a duplicate of the first', async ({
  page,
  context,
  baseURL,
}) => {
  const first = MOCK_DOCUMENTS.invoice
  const second = MOCK_DOCUMENTS.duplicateInvoice
  const { user, loads } = await openDocuments(page, context, baseURL!)
  await upload(page, first)
  await expect(row(page, first.name)).toContainText('Needs review', PIPELINE)
  await upload(page, second)

  // Flagged, not refused (OQ-9, Lead ruling 4 on #27).
  await expect(row(page, second.name).getByRole('cell')).toHaveText([second.name, 'Invoice', 'Needs review', '1'], PIPELINE)
  await expect(row(page, first.name).getByRole('cell')).toHaveText([first.name, 'Invoice', 'Needs review', '1'])
  expect(loads.count).toBe(0)
  await expectNoSideScroll(page)

  const a = await documentOf(user, first.name)
  const b = await documentOf(user, second.name)
  const [dup] = await sql<{ duplicate_of: string | null }>('select duplicate_of from public.documents where id = $1', [b.id])
  expect(dup.duplicate_of).toBe(a.id)
  const [u1] = await sql<{ status: string; message: string }>(
    "select status, message from public.check_results where document_id = $1 and check_id = 'U1'",
    [b.id],
  )
  expect(u1).toEqual({ status: 'fail', message: `Duplicate of "${first.name}": the same vendor and invoice number.` })
  const flagged = await sql<{ path: string }>(
    "select path from public.extraction_fields where document_id = $1 and 'duplicate' = any(flags) order by path",
    [b.id],
  )
  expect(flagged.map((f) => f.path)).toEqual(['invoice_number', 'vendor_tax_id'])
  // The earlier one is not changed.
  const [original] = await sql<{ status: string }>("select status from public.check_results where document_id = $1 and check_id = 'U1'", [a.id])
  expect(original.status).toBe('pass')
})

test('a document that is none of the types reaches Not supported, with its reason, and counts no pages', async ({
  page,
  context,
  baseURL,
}) => {
  const doc = MOCK_DOCUMENTS.letter
  const { user, loads } = await openDocuments(page, context, baseURL!)
  await upload(page, doc)

  await expect(row(page, doc.name)).toContainText('Not supported', PIPELINE)
  await expect(row(page, doc.name)).toContainText(
    'Not a supported document type: This is a cover letter, not a business document.',
  )
  await expect(row(page, doc.name).getByRole('button', { name: /Retry/ })).toHaveCount(0)
  expect(loads.count).toBe(0)
  await expectNoSideScroll(page)
  expect(await documentOf(user, doc.name)).toMatchObject({ status: 'unsupported', doc_type: null, pages_reserved: false })
  expect(await accountPagesUsed(user)).toBe(0)
})

test('an upload at the daily ceiling is shown as Waiting for budget, naming the limit and when it resets', async ({
  page,
  context,
  baseURL,
}) => {
  const doc = MOCK_DOCUMENTS.atTheCeiling
  const today = "(now() at time zone 'utc')::date"
  const [before] = await sql<{ spent_usd: string }>(`select spent_usd from public.ai_spend_days where day = ${today}`)
  await sql(
    `insert into public.ai_spend_days (day, cap_usd, spent_usd) values (${today}, 2, 2)
     on conflict (day) do update set spent_usd = 2`,
  )
  try {
    const { user, loads } = await openDocuments(page, context, baseURL!)
    await upload(page, doc)

    await expect(row(page, doc.name)).toContainText('Waiting for budget', PIPELINE)
    await expect(row(page, doc.name)).toContainText('The daily AI spending limit is reached. It resets at 00:00 UTC on')
    expect(loads.count).toBe(0)
    await expectNoSideScroll(page)
    // Accepted, its pages held, no attempt counted, and Claude not called.
    const stored = await documentOf(user, doc.name)
    expect(stored).toMatchObject({ status: 'waiting_budget', pages_reserved: true })
    const [attempts] = await sql<{ attempts: number }>('select attempts from public.documents where id = $1', [stored.id])
    expect(attempts.attempts).toBe(0)
    expect(await sql('select 1 from public.extractions where document_id = $1', [stored.id])).toEqual([])
  } finally {
    await sql(`update public.ai_spend_days set spent_usd = $1 where day = ${today}`, [before?.spent_usd ?? 0])
  }
})

test('a file Claude cannot read reaches Failed with its reason, and Retry sends it back to Queued', async ({
  page,
  context,
  baseURL,
}) => {
  const doc = MOCK_DOCUMENTS.unreadable
  const { user, loads } = await openDocuments(page, context, baseURL!)
  await upload(page, doc)

  await expect(row(page, doc.name)).toContainText('Failed', PIPELINE)
  await expect(row(page, doc.name)).toContainText(
    'Claude could not read this file. It may be damaged, password-protected or too large.',
  )
  const retry = row(page, doc.name).getByRole('button', { name: `Retry ${doc.name}` })
  await expect(retry).toBeVisible()
  await expectNoSideScroll(page)
  // A failure counts no pages (OQ-10).
  expect(await accountPagesUsed(user)).toBe(0)

  // Extraction paused, so the retried document stays Queued long enough to be seen.
  await sql('update public.app_config set extract_concurrency = 0')
  try {
    await retry.click()
    await expect(row(page, doc.name).getByRole('cell')).toHaveText([doc.name, '', 'Queued', '1'])
    await expect(retry).toHaveCount(0)
    expect(loads.count).toBe(0)
    expect(await documentOf(user, doc.name)).toMatchObject({ status: 'queued', pages_reserved: true })
    expect(await accountPagesUsed(user)).toBe(1)
    const events = await sql('select kind, actor from public.document_events where document_id = $1', [
      (await documentOf(user, doc.name)).id,
    ])
    expect(events).toEqual([{ kind: 'retried', actor: user.id }])
  } finally {
    await sql('update public.app_config set extract_concurrency = 1')
  }
})

test('Retry is not offered once the file is deleted', async ({ page, context, baseURL }) => {
  const user = await createUser()
  const [ws] = await sql<{ workspace_id: string }>('select workspace_id from public.workspace_members where user_id = $1', [user.id])
  await sql(
    `insert into public.documents (workspace_id, uploaded_by, status, status_reason, file_name, mime_type, byte_size, page_count, storage_path, file_deleted_at)
     values ($1::uuid, $2, 'failed', 'Claude could not read this file.', 'Old scan.pdf', 'application/pdf', 100, 1, $1::text || '/x/original', now())`,
    [ws.workspace_id, user.id],
  )
  await signIn(context, baseURL!, user)
  await page.goto('/documents')
  await expect(row(page, 'Old scan.pdf')).toContainText('Claude could not read this file.')
  await expect(row(page, 'Old scan.pdf').getByRole('button', { name: /Retry/ })).toHaveCount(0)
})
