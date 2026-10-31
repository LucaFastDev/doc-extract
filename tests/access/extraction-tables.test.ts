import { beforeAll, describe, expect, it } from 'vitest'
import { withDb } from './local-db'
import { addMember, anonClient, createDocument, personalWorkspaceId, signUp, type TestUser } from './users'

// document_events, extraction_fields, check_results, extractions, the spend tables and app_config
// (ARCHITECTURE.md section 4.2, milestone 5): members read their workspace's history, fields and
// check results; nobody else reads them; no client writes any of them; no client reads
// extractions, the spend tables or app_config at all.

/** One row in each per-document table, written as postgres, as process-queue would. */
async function resultRows(ws: string, doc: string, label: string) {
  await withDb(async (db) => {
    await db.query(`insert into public.document_events (document_id, workspace_id, kind) values ($1, $2, 'retried')`, [doc, ws])
    await db.query(
      `insert into public.extraction_fields (document_id, workspace_id, path, kind, extracted_value, confidence, flags)
       values ($1, $2, 'total', 'amount', $3, 0.95, '{}')`,
      [doc, ws, label],
    )
    await db.query(
      `insert into public.check_results (document_id, workspace_id, check_id, status, field_paths, message, evaluated_at)
       values ($1, $2, 'A4', 'skipped', '{total}', $3, now())`,
      [doc, ws, label],
    )
    await db.query(
      `insert into public.extractions (document_id, workspace_id, model, prompt_version, tool_name, outcome, input_tokens, output_tokens, cost_usd)
       values ($1, $2, 'claude-sonnet-5-5', 'test', 'record_invoice', 'ok', 10, 10, 0.0001)`,
      [doc, ws],
    )
  })
}

const MEMBER_TABLES = ['document_events', 'extraction_fields', 'check_results'] as const
const SERVER_TABLES = ['extractions', 'ai_spend_periods', 'ai_spend_days', 'ai_spend_reservations', 'app_config'] as const

describe('result tables', () => {
  let ownerA: TestUser
  let memberA: TestUser
  let ownerB: TestUser
  let wsA: string
  let docA: string
  let docB: string

  beforeAll(async () => {
    ownerA = await signUp()
    memberA = await signUp()
    ownerB = await signUp()
    wsA = await personalWorkspaceId(ownerA)
    await addMember(wsA, memberA, 'member')
    const wsB = await personalWorkspaceId(ownerB)
    docA = (await createDocument(ownerA, wsA)).id
    docB = (await createDocument(ownerB, wsB)).id
    await resultRows(wsA, docA, '100.00')
    await resultRows(wsB, docB, '200.00')
  })

  it.each(MEMBER_TABLES)('%s: a member selects their own workspace’s rows only', async (table) => {
    for (const user of [ownerA, memberA]) {
      const { data, error } = await user.client.from(table).select('document_id, workspace_id')
      expect(error).toBeNull()
      expect(data).toEqual([{ document_id: docA, workspace_id: wsA }])
    }
    const b = await ownerB.client.from(table).select('document_id')
    expect(b.data).toEqual([{ document_id: docB }])
  })

  it.each(MEMBER_TABLES)('%s: a non-member and anon see none of a workspace’s rows', async (table) => {
    const stranger = await signUp()
    const { data, error } = await stranger.client.from(table).select('document_id')
    expect(error).toBeNull()
    expect(data).toEqual([])
    const anon = await anonClient().from(table).select('document_id')
    expect(anon.data ?? []).toEqual([])
  })

  it.each(MEMBER_TABLES)('%s: no client inserts, updates or deletes', async (table) => {
    const row =
      table === 'document_events'
        ? { document_id: docA, workspace_id: wsA, kind: 'retried' }
        : table === 'extraction_fields'
          ? { document_id: docA, workspace_id: wsA, path: 'vendor_name', kind: 'text' }
          : { document_id: docA, workspace_id: wsA, check_id: 'A1', status: 'pass' }
    const attempts = [
      ownerA.client.from(table).insert(row),
      ownerA.client.from(table).update({ workspace_id: wsA }).eq('document_id', docA),
      ownerA.client.from(table).delete().eq('document_id', docA),
      anonClient().from(table).insert(row),
      anonClient().from(table).delete().eq('document_id', docA),
    ]
    for (const attempt of attempts) {
      expect((await attempt).error?.code).toBe('42501')
    }
    const count = await withDb(async (db) => {
      const { rows } = await db.query(`select count(*)::int as n from public.${table} where document_id = $1`, [docA])
      return rows[0].n
    })
    expect(count).toBe(1)
  })

  it('a member cannot change an extracted value (corrections come in milestone 7)', async () => {
    const { error } = await ownerA.client
      .from('extraction_fields')
      .update({ extracted_value: '1.00', corrected_value: '1.00' })
      .eq('document_id', docA)
    expect(error?.code).toBe('42501')
  })

  it.each(SERVER_TABLES)('%s: no client reads or writes it', async (table) => {
    for (const client of [ownerA.client, anonClient()]) {
      const read = await client.from(table).select('*')
      expect(read.error?.code).toBe('42501')
      const insert = await client.from(table).insert({})
      expect(insert.error?.code).toBe('42501')
    }
  })
})

describe('app_config', () => {
  it('holds its one row with the section 4.2 values and the Sonnet 5.5 prices', async () => {
    const rows = await withDb(async (db) => (await db.query('select * from public.app_config')).rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: true,
      spend_cap_usd: '10.00',
      daily_cap_usd: '2.00',
      account_page_cap: 10,
      model: 'claude-sonnet-5-5',
      input_usd_per_mtok: '2.000',
      output_usd_per_mtok: '10.000',
      confidence_threshold: '0.800',
      amount_tolerance: '0.01',
      extract_concurrency: 1,
    })
    for (const column of ['base_input_tokens', 'max_input_tokens_per_page', 'max_output_tokens']) {
      expect(rows[0][column]).toBeGreaterThan(0)
    }
  })

  it('cannot hold a second row', async () => {
    const error = await withDb((db) =>
      db.query('insert into public.app_config (id) values (false)').then(
        () => null,
        (e: { code: string }) => e.code,
      ),
    )
    expect(error).toBe('23514')
  })
})
