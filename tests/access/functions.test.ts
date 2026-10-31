import { describe, expect, it } from 'vitest'
import { withDb } from './local-db'

// The rule for every database function (ARCHITECTURE.md section 4.1): its security mode, an empty
// search_path, and execute granted to exactly the roles in its row. Later milestones add their
// functions to this table.
const FUNCTIONS = [
  { signature: 'public.is_member(uuid)', definer: true, roles: ['authenticated'] },
  { signature: 'public.is_owner(uuid)', definer: true, roles: ['authenticated'] },
  { signature: 'public.create_workspace(text)', definer: true, roles: ['authenticated'] },
  { signature: 'public.handle_new_user()', definer: true, roles: [] },
  { signature: 'public.create_invite(uuid, text, text)', definer: true, roles: ['authenticated'] },
  { signature: 'public.accept_invite(text)', definer: true, roles: ['authenticated'] },
  { signature: 'public.remove_member(uuid, uuid)', definer: true, roles: ['authenticated'] },
  { signature: 'public.set_member_role(uuid, uuid, text)', definer: true, roles: ['authenticated'] },
]

const ROLES = ['public', 'anon', 'authenticated', 'service_role']

describe('database functions', () => {
  it.each(FUNCTIONS)('$signature has its security mode and an empty search_path', async (fn) => {
    const row = await withDb(async (db) => {
      const { rows } = await db.query<{ definer: boolean; config: string[] | null; owner: string }>(
        `select p.prosecdef as definer, p.proconfig as config, r.rolname as owner
         from pg_proc p join pg_roles r on r.oid = p.proowner
         where p.oid = $1::regprocedure`,
        [fn.signature],
      )
      return rows[0]
    })
    expect(row.definer).toBe(fn.definer)
    expect(row.config).toEqual(['search_path=""'])
    expect(row.owner).toBe('postgres')
  })

  it.each(FUNCTIONS)('$signature can be executed by exactly its roles', async (fn) => {
    const allowed = await withDb(async (db) => {
      const result: string[] = []
      for (const role of ROLES) {
        // PUBLIC is not a role has_function_privilege accepts; check the ACL entry instead.
        const sql =
          role === 'public'
            ? `select exists (select 1 from aclexplode((select coalesce(proacl, acldefault('f', proowner)) from pg_proc where oid = $1::regprocedure)) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as ok`
            : `select has_function_privilege('${role}', $1::regprocedure, 'execute') as ok`
        const { rows } = await db.query<{ ok: boolean }>(sql, [fn.signature])
        if (rows[0].ok) result.push(role)
      }
      return result
    })
    expect(allowed).toEqual(fn.roles)
  })

  it('runs handle_new_user after insert on auth.users', async () => {
    const triggers = await withDb(async (db) => {
      const { rows } = await db.query<{ fn: string }>(
        `select t.tgfoid::regprocedure::text as fn from pg_trigger t
         where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal`,
      )
      return rows.map((r) => r.fn)
    })
    expect(triggers).toContain('handle_new_user()')
  })
})

describe('tables', () => {
  it('have RLS enabled and no policy open to every row', async () => {
    const { tables, open } = await withDb(async (db) => {
      const t = await db.query<{ relname: string; rls: boolean }>(
        `select c.relname, c.relrowsecurity as rls from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by c.relname`,
      )
      const p = await db.query<{ policyname: string }>(
        `select policyname from pg_policies where schemaname = 'public'
         and (qual = 'true' or with_check = 'true')`,
      )
      return { tables: t.rows, open: p.rows }
    })
    expect(tables.map((t) => t.relname)).toEqual(
      expect.arrayContaining(['profiles', 'workspace_invites', 'workspace_members', 'workspaces']),
    )
    expect(tables.filter((t) => !t.rls)).toEqual([])
    expect(open).toEqual([])
  })
})
