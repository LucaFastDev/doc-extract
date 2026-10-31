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
