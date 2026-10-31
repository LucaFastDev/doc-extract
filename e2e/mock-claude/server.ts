import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { MOCK_DOCUMENTS } from './documents.ts'
import { mockClaudePort } from './port.ts'

// A stand-in for the Messages API (ARCHITECTURE.md section 9, "How tests mock Claude"), started by
// Playwright's webServer and reached by the local Edge Functions through ANTHROPIC_BASE_URL. It
// answers POST /v1/messages by the SHA-256 of the file in the request, with a recorded response
// from supabase/functions/_shared/fixtures/ (or, for a request that sends only the tool of a type
// the user chose, the document's answer for that tool), and refuses a request whose shape breaks Lead ruling 1
// on #24 (tool_choice auto, every tool strict) with a 400, so a wrong request fails the spec that
// sent it. GET /requests lists what it was sent, for the specs to check. Run with
// `node e2e/mock-claude/server.ts`. Nothing here reaches the real API.

const FIXTURES = new URL('../../supabase/functions/_shared/fixtures/', import.meta.url)

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const bySha = new Map(Object.values(MOCK_DOCUMENTS).map((d) => [sha256(d.buffer), d]))
const calls = new Map<string, number>()

interface Seen {
  sha256: string | null
  tool_choice: unknown
  tools: { name: string; strict: unknown }[]
  status: number
}
const seen: Seen[] = []

function error(status: number, message: string) {
  return { status, body: { type: 'error', error: { type: 'invalid_request_error', message: `mock-claude: ${message}` } } }
}

interface MessagesRequest {
  model?: string
  tool_choice?: { type?: string }
  tools?: { name: string; strict?: unknown }[]
  messages?: { content?: { type: string; source?: { data?: string } }[] }[]
}

function answer(request: MessagesRequest): { status: number; body: unknown; sha: string | null } {
  const block = request.messages?.[0]?.content?.find((b) => b.type === 'document' || b.type === 'image')
  const sha = block?.source?.data ? sha256(Buffer.from(block.source.data, 'base64')) : null
  if (request.tool_choice?.type !== 'auto') return { ...error(400, 'tool_choice must be auto'), sha }
  if (!request.tools?.length || request.tools.some((t) => t.strict !== true)) {
    return { ...error(400, 'every tool must be strict'), sha }
  }
  const doc = sha ? bySha.get(sha) : undefined
  if (!sha || !doc) return { ...error(400, 'no recording for this file'), sha }

  const chosen = request.tools.length === 1 ? doc.asChosen?.[request.tools[0].name] : undefined
  const n = (calls.get(sha) ?? 0) + 1
  if (!chosen) calls.set(sha, n)
  const name = chosen ?? doc.responses[Math.min(n, doc.responses.length) - 1]
  const fixture = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as { status: number; body: Record<string, unknown> }
  const body = fixture.status === 200 ? { ...fixture.body, model: request.model } : fixture.body
  return { status: fixture.status, body, sha }
}

const server = createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true })
  if (req.method === 'GET' && req.url === '/requests') return send(200, seen)
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) return send(404, error(404, 'not found').body)
  if (!req.headers['x-api-key']) return send(401, error(401, 'no x-api-key').body)

  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    let request: MessagesRequest
    try {
      request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MessagesRequest
    } catch {
      return send(400, error(400, 'the body is not JSON').body)
    }
    const { status, body, sha } = answer(request)
    seen.push({
      sha256: sha,
      tool_choice: request.tool_choice,
      tools: (request.tools ?? []).map((t) => ({ name: t.name, strict: t.strict })),
      status,
    })
    send(status, body)
  })
})

// The local Edge Functions run in Docker and reach this server as host.docker.internal: Docker
// Desktop forwards that to the Mac's loopback, while on Linux (CI) it is the bridge gateway, so the
// server must listen beyond loopback there.
const host = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1'
const port = mockClaudePort()
server.listen(port, host, () => console.log(`mock-claude listening on ${host}:${port}`))
