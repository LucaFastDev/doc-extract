import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { utcDate } from '../../shared/doctypes/checks'
import { prepareResult } from '../../shared/doctypes/index'
import { INVOICE_FIELDS } from '../../shared/doctypes/invoice'
import { adminClient, sql, type TestUser } from './auth'
import type { FilePayload } from './files'

// Documents for the review specs (milestone 7), stored as process-queue would leave them: the rows
// record_extraction writes for a tool call, and the file in Storage. The upload specs run with
// extraction paused, so these never pass through Claude, mocked or not.

const f = (value: string, confidence = 0.95) => ({ value, confidence })

/**
 * An invoice whose subtotal was read as 120.00 (low confidence) while its line sums to 100.00,
 * so A2 and A3 fail, and whose due date is before its invoice date, so D2 fails. Correcting the
 * subtotal to 100.00 passes A2 and A3; D2 needs a tick.
 */
export function invoiceInput(overrides: Record<string, { value: string; confidence: number }> = {}) {
  return {
    ...Object.fromEntries(INVOICE_FIELDS.map((d) => [d.name, f('')])),
    vendor_name: f('Acme Supplies Ltd'),
    invoice_number: f(`INV-${randomUUID().slice(0, 6)}`),
    currency: f('EUR'),
    currency_as_printed: f('€'),
    invoice_date: f('2026-10-01'),
    due_date: f('2026-09-01'),
    subtotal: f('120.00', 0.55),
    discount_total: f('0.00'),
    shipping: f('0.00'),
    tax_total: f('19.00'),
    total: f('119.00'),
    ...overrides,
    line_items: [
      { description: f('Widgets'), item_code: f('W-1'), quantity: f('4'), unit: f('pcs'), unit_price: f('25.00'), tax_rate: f('19'), amount: f('100.00') },
    ],
  }
}

export interface SeedOptions {
  file: FilePayload
  status?: 'needs_review' | 'approved' | 'unsupported'
  /** The invoice's tool input; none for a not supported document. */
  input?: Record<string, unknown>
  statusReason?: string
  fileDeleted?: boolean
}

/** A document in the user's personal workspace, extracted, with its file in Storage. */
export async function seedDocument(user: TestUser, o: SeedOptions): Promise<string> {
  const [{ workspace_id: ws }] = await sql<{ workspace_id: string }>('select workspace_id from public.workspace_members where user_id = $1', [
    user.id,
  ])
  const id = randomUUID()
  const path = `${ws}/${id}/original`
  const pages = o.file.mimeType === 'application/pdf' ? 2 : 1
  await sql(
    `insert into public.documents (id, workspace_id, uploaded_by, status, status_reason, file_name, mime_type, byte_size, page_count, sha256, storage_path, created_at)
     values ($1, $2, $3, 'processing', $4, $5, $6, $7, $8, $9, $10, now() - interval '1 minute')`,
    [id, ws, user.id, o.statusReason ?? null, o.file.name, o.file.mimeType, o.file.buffer.length, pages, randomUUID(), path],
  )
  if (o.fileDeleted) {
    await sql("update public.documents set file_deleted_at = created_at + interval '7 days' where id = $1", [id])
  } else {
    const { error } = await adminClient().storage.from('documents').upload(path, o.file.buffer, { contentType: o.file.mimeType })
    if (error) throw error
  }

  if (o.status === 'unsupported') {
    await sql("update public.documents set status = 'unsupported', processed_at = now() where id = $1", [id])
    return id
  }
  const prepared = prepareResult('invoice', o.input ?? invoiceInput(), { confidenceThreshold: 0.8, amountTolerance: '0.01', today: utcDate(new Date()) })
  if (!prepared.ok) throw new Error(prepared.errors.join('; '))
  await sql('select public.record_extraction($1, null, $2)', [
    id,
    {
      outcome: 'ok',
      status: 'needs_review',
      model: 'claude-sonnet-5-5',
      prompt_version: 'e2e',
      tool_name: 'record_invoice',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      doc_type: 'invoice',
      fields: prepared.fields,
      checks: prepared.checks,
      duplicate: { key: prepared.duplicate.key, label: prepared.duplicate.label },
    },
  ])
  if (o.status === 'approved') {
    await sql("update public.documents set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, user.id])
  }
  return id
}

/** No part of the page is wider than the viewport (OQ-40). */
export async function expectNoSideScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }))
  expect(scroll).toBeLessThanOrEqual(width)
}

/** A detail in the review screen's header, such as Type or Status. */
export function detail(page: Page, term: string) {
  return page.locator('dl > div').filter({ has: page.locator('dt', { hasText: term }) }).locator('dd')
}

/** The check's entry in the Checks section. */
export function check(page: Page, id: string) {
  return page.locator(`[data-check="${id}"]`)
}

/** A field's entry, by its path, such as subtotal or line_items[0].amount. */
export function field(page: Page, path: string) {
  return page.locator(`[data-field="${path}"]`)
}
