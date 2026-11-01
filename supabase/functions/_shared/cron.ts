// The door of the functions pg_cron calls, process-queue and purge-files (ARCHITECTURE.md section
// 6.1): only pg_cron, which sends CRON_SECRET in the x-cron-secret header, may run them. JWT
// verification is off for both, so this check is the whole of their authentication.

/** Compares in time independent of where the strings differ. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]
  return diff === 0
}

/**
 * Answers 401, running nothing, without the right x-cron-secret header; otherwise runs the job
 * and answers with its result, or 500 without the error's details when it throws.
 */
export async function handleCronRequest(
  req: Request,
  secret: string,
  job: { name: string; failure: string },
  run: () => Promise<unknown>,
): Promise<Response> {
  const given = req.headers.get('x-cron-secret')
  if (!given || !sameSecret(given, secret)) return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  try {
    return Response.json(await run())
  } catch (error) {
    console.error(`${job.name} failed`, error)
    return Response.json({ error: job.failure }, { status: 500 })
  }
}
