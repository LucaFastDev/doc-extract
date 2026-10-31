import pg from 'pg'

// Access tests run only against the local stack: a hosted database here would be production.
const LOCAL_DB_URL = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/postgres$/

export function localDbUrl(): string {
  const url = process.env.SUPABASE_DB_URL
  if (!url) {
    throw new Error('SUPABASE_DB_URL is not set. Put the DB URL from `npx supabase status` in .env.local.')
  }
  if (!LOCAL_DB_URL.test(url)) {
    throw new Error('SUPABASE_DB_URL is not the local stack; access tests never run against a hosted database.')
  }
  return url
}

/**
 * Runs fn in a transaction that is always rolled back, so a test can set rows that every test
 * shares (today's spend, app_config) without leaving them changed.
 */
export async function rolledBack<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query('begin')
    try {
      return await fn(db)
    } finally {
      await db.query('rollback')
    }
  })
}

/** Inside a transaction: act as the service role, as the Edge Functions do. */
export async function asServiceRole(db: pg.Client): Promise<void> {
  await db.query('set local role service_role')
}

/** Inside a transaction: act as a signed-in user, as PostgREST does with their JWT. */
export async function asUser(db: pg.Client, userId: string): Promise<void> {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  await db.query('set local role authenticated')
}

/** Runs fn with a direct connection to the local database, as postgres, and closes it after. */
export async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: localDbUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
