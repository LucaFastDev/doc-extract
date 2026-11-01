import { handleCronRequest } from '../_shared/cron.ts'

// process-queue's door (ARCHITECTURE.md section 6.1): only pg_cron, which sends CRON_SECRET in the
// x-cron-secret header, may run a queue step. The check is shared with purge-files.

export function handleRequest(req: Request, secret: string, run: () => Promise<unknown>): Promise<Response> {
  return handleCronRequest(req, secret, { name: 'process-queue', failure: 'The queue step failed.' }, run)
}
