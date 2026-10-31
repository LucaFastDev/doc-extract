import { describe, expect, it } from 'vitest'
import { withDb } from './local-db'

// The first migration enables the extensions the extraction pipeline runs on (ARCHITECTURE.md
// section 1). Later milestones add a file here per table.
describe('extensions migration', () => {
  it('installs pgmq, pg_cron and pg_net', async () => {
    const names = await withDb(async (db) => {
      const { rows } = await db.query<{ extname: string }>(
        "select extname from pg_extension where extname in ('pgmq', 'pg_cron', 'pg_net') order by extname",
      )
      return rows.map((r) => r.extname)
    })
    expect(names).toEqual(['pg_cron', 'pg_net', 'pgmq'])
  })

  // Without usage on a schema, a role cannot call its functions, whatever their own grants say.
  // The net schema is left out: Supabase grants usage on it to PUBLIC as supabase_admin when
  // pg_net is created, which a migration, run as postgres, cannot revoke.
  it('gives anon and authenticated no use of the pgmq or cron schemas', async () => {
    const grants = await withDb(async (db) => {
      const { rows } = await db.query<{ role: string; schema: string; usage: boolean }>(
        `select r as role, s as schema, has_schema_privilege(r, s, 'usage') as usage
         from unnest(array['anon', 'authenticated']) as r, unnest(array['cron', 'pgmq']) as s
         order by r, s`,
      )
      return rows
    })
    expect(grants).toEqual([
      { role: 'anon', schema: 'cron', usage: false },
      { role: 'anon', schema: 'pgmq', usage: false },
      { role: 'authenticated', schema: 'cron', usage: false },
      { role: 'authenticated', schema: 'pgmq', usage: false },
    ])
  })

  it('refuses pgmq.send to a signed-out client', async () => {
    const result = await withDb(async (db) => {
      await db.query('begin')
      try {
        await db.query('set local role anon')
        await db.query("select pgmq.send('extract', '{}'::jsonb)")
        return 'allowed'
      } catch (error) {
        return (error as Error).message
      } finally {
        await db.query('rollback')
      }
    })
    expect(result).toMatch(/permission denied for schema pgmq/)
  })
})
