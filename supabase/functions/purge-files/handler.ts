import { handleCronRequest } from '../_shared/cron.ts'

// purge-files' door (ARCHITECTURE.md sections 6.1 and 8): the same CRON_SECRET check as
// process-queue, so only the daily pg_cron job may run a purge.

export function handleRequest(req: Request, secret: string, run: () => Promise<unknown>): Promise<Response> {
  return handleCronRequest(req, secret, { name: 'purge-files', failure: 'The purge failed.' }, run)
}
