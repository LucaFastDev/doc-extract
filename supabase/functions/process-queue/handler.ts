// process-queue's door (ARCHITECTURE.md section 6.1): only pg_cron, which sends CRON_SECRET in the
// x-cron-secret header, may run a queue step. JWT verification is off for this function, so this
// check is the whole of its authentication.

/** Compares in time independent of where the strings differ. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]
  return diff === 0
}

export async function handleRequest(req: Request, secret: string, run: () => Promise<unknown>): Promise<Response> {
  const given = req.headers.get('x-cron-secret')
  if (!given || !sameSecret(given, secret)) return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  try {
    return Response.json(await run())
  } catch (error) {
    console.error('process-queue failed', error)
    return Response.json({ error: 'The queue step failed.' }, { status: 500 })
  }
}
