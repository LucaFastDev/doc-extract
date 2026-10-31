import { PDFDocument } from 'pdf-lib'
import { beforeEach, describe, expect, it } from 'vitest'
import { submitDocument, type SubmitDeps, type SubmittedDocument } from './submit'

// submit-document's steps (ARCHITECTURE.md sections 2 and 6.1, PRD US-1.1 AC-3, AC-5 and AC-6):
// the caller must be a member of the document's workspace, the document must be uploading, the
// file must pass every check, and only then are pages reserved and the document queued. Every
// refusal leaves the pages uncounted.

const WS = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage()
  return doc.save()
}

interface Fake extends SubmitDeps {
  calls: string[]
  reserved: number
  rejected: { reason: string; page_count?: number | null; sha256?: string | null } | null
  queued: boolean
  recorded: { page_count: number; sha256: string } | null
  enqueued: string | null
  /** The document's status in the database, which reject changes only from the statuses it is given. */
  status: string
}

function fake(overrides: Partial<SubmitDeps> & { file?: Uint8Array | null; doc?: Partial<SubmittedDocument> | null } = {}): Fake {
  const doc: SubmittedDocument | null =
    overrides.doc === null
      ? null
      : {
          id: DOC,
          workspace_id: WS,
          status: 'uploading',
          file_name: 'Invoice.pdf',
          mime_type: 'application/pdf',
          storage_path: `${WS}/${DOC}/original`,
          ...overrides.doc,
        }
  const f: Fake = {
    calls: [],
    reserved: 0,
    rejected: null,
    queued: false,
    recorded: null,
    userId: async () => 'user-1',
    loadDocument: async () => doc,
    isMember: async () => true,
    download: async () => (overrides.file === undefined ? pdf(2) : overrides.file),
    recordFile: async (_id, file) => {
      f.calls.push('recordFile')
      f.recorded = file
    },
    reservePages: async () => {
      f.calls.push('reservePages')
      f.reserved += 1
      return true
    },
    allowance: async () => ({ workspace_used: 0, workspace_limit: 20, account_used: 0, account_cap: 10 }),
    status: doc?.status ?? 'uploading',
    reject: async (_id, reason, from, file) => {
      f.calls.push('reject')
      if (!from.includes(f.status)) return
      f.status = 'rejected'
      f.rejected = { reason, ...file }
    },
    queue: async () => {
      f.calls.push('queue')
      f.queued = true
      f.status = 'queued'
    },
    enqueued: null,
    enqueue: async (id) => {
      f.enqueued = id
    },
    releasePages: async () => {
      f.calls.push('releasePages')
    },
  }
  return Object.assign(f, overrides)
}

describe('submitDocument', () => {
  let deps: Fake

  beforeEach(() => {
    deps = fake()
  })

  it('counts the pages, stores the SHA-256, reserves the pages and queues the document', async () => {
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result).toEqual({ status: 202, body: { document: { id: DOC, status: 'queued', page_count: 2 } } })
    expect(deps.recorded).toEqual({ page_count: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(deps.calls).toEqual(['recordFile', 'reservePages', 'queue'])
  })

  it('counts an image as one page', async () => {
    deps = fake({ file: PNG, doc: { mime_type: 'image/png', file_name: 'receipt.png' } })
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result.status).toBe(202)
    expect(deps.recorded?.page_count).toBe(1)
  })

  it('refuses a request without a document id', async () => {
    for (const body of [null, {}, { document_id: 'not-a-uuid' }, 'x']) {
      expect((await submitDocument(body, deps)).status).toBe(400)
    }
    expect(deps.calls).toEqual([])
  })

  it('refuses a caller who is not signed in', async () => {
    deps = fake({ userId: async () => null })
    expect((await submitDocument({ document_id: DOC }, deps)).status).toBe(401)
    expect(deps.calls).toEqual([])
  })

  it('refuses a caller who cannot see the document, or is not a member of its workspace', async () => {
    deps = fake({ doc: null })
    expect((await submitDocument({ document_id: DOC }, deps)).status).toBe(404)
    deps = fake({ isMember: async () => false })
    expect((await submitDocument({ document_id: DOC }, deps)).status).toBe(403)
    expect(deps.calls).toEqual([])
  })

  it('refuses a document that is no longer uploading, and changes nothing', async () => {
    deps = fake({ doc: { status: 'queued' } })
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result.status).toBe(409)
    expect(deps.calls).toEqual([])
  })

  it('rejects a file whose upload is missing, counting no pages', async () => {
    deps = fake({ file: null })
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result.status).toBe(409)
    expect(deps.calls).toEqual(['reject'])
  })

  it('rejects a file whose magic bytes do not match its type, counting no pages', async () => {
    deps = fake({ file: PNG })
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result).toEqual({ status: 409, body: { error: expect.stringContaining('Accepted types: PDF, JPEG, PNG and WebP') } })
    expect(deps.rejected?.reason).toBe((result.body as { error: string }).error)
    expect(deps.calls).toEqual(['reject'])
  })

  it('rejects a PDF it cannot read, counting no pages', async () => {
    deps = fake({ file: new TextEncoder().encode('%PDF-1.7\nbroken') })
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result).toEqual({ status: 409, body: { error: 'Invoice.pdf could not be read as a PDF.' } })
    expect(deps.calls).toEqual(['reject'])
  })

  it('rejects a PDF over 10 pages with a message naming the limit, counting no pages', async () => {
    deps = fake({ file: await pdf(11) })
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result).toEqual({
      status: 409,
      body: { error: 'Invoice.pdf has 11 pages. A document can have at most 10 pages.' },
    })
    expect(deps.rejected).toMatchObject({ page_count: 11, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(deps.calls).toEqual(['reject'])
  })

  it('rejects an upload over the allowances, saying how many pages remain', async () => {
    deps = fake({
      reservePages: async () => {
        deps.calls.push('reservePages')
        return false
      },
      allowance: async () => ({ workspace_used: 3, workspace_limit: 20, account_used: 9, account_cap: 10 }),
    })
    const result = await submitDocument({ document_id: DOC }, deps)
    expect(result.status).toBe(409)
    expect((result.body as { error: string }).error).toContain('only 1 page remains')
    expect(deps.calls).toEqual(['recordFile', 'reservePages', 'reject'])
    expect(deps.queued).toBe(false)
  })
})

// Milestone 5 (ARCHITECTURE.md sections 2 and 6.1, Lead ruling on #20): after reserve_pages the
// document is set queued and sent to the extract queue; if any step after reserve_pages fails, its
// pages are released, so a document that never reaches the queue holds none.
describe('submitDocument and the extract queue', () => {
  it('sends the queued document to extract after reserving its pages', async () => {
    const deps = fake()
    expect((await submitDocument({ document_id: DOC }, deps)).status).toBe(202)
    expect(deps.enqueued).toBe(DOC)
    expect(deps.calls).not.toContain('releasePages')
  })

  it('does not send a document it refused', async () => {
    const deps = fake({ file: await pdf(11) })
    await submitDocument({ document_id: DOC }, deps)
    expect(deps.enqueued).toBeNull()
  })

  it('releases the pages and rejects the document when the enqueue fails', async () => {
    const deps = fake({
      enqueue: async () => {
        throw new Error('pgmq unavailable')
      },
    })
    await expect(submitDocument({ document_id: DOC }, deps)).rejects.toThrow('pgmq unavailable')
    expect(deps.calls).toEqual(['recordFile', 'reservePages', 'queue', 'releasePages', 'reject'])
    expect(deps.rejected?.reason).toBe('Invoice.pdf could not be queued for extraction. Upload it again.')
  })

  it('releases the pages when setting the status to queued fails', async () => {
    const deps = fake({
      queue: async () => {
        throw new Error('update failed')
      },
    })
    await expect(submitDocument({ document_id: DOC }, deps)).rejects.toThrow('update failed')
    expect(deps.calls).toEqual(['recordFile', 'reservePages', 'releasePages', 'reject'])
    expect(deps.enqueued).toBeNull()
  })

  it('still reports the first failure when giving the pages back fails too', async () => {
    const deps = fake({
      enqueue: async () => {
        throw new Error('pgmq unavailable')
      },
      releasePages: async () => {
        throw new Error('release failed')
      },
    })
    await expect(submitDocument({ document_id: DOC }, deps)).rejects.toThrow('pgmq unavailable')
  })

  // Lead ruling on review 1 of #25: only the "could not be queued" path rejects a queued document.
  it('leaves a document a concurrent submit queued as queued when this submit refuses it', async () => {
    for (const file of [null, PNG, new TextEncoder().encode('%PDF-1.7\nbroken'), await pdf(11)]) {
      const deps: Fake = fake({
        // The other submit passed the uploading check too, and queued the document meanwhile.
        download: async () => {
          deps.status = 'queued'
          return file
        },
      })
      expect((await submitDocument({ document_id: DOC }, deps)).status).toBe(409)
      expect(deps.calls).toContain('reject')
      expect(deps.status).toBe('queued')
      expect(deps.rejected).toBeNull()
    }

    const overAllowance: Fake = fake({
      reservePages: async () => {
        overAllowance.status = 'queued'
        return false
      },
    })
    expect((await submitDocument({ document_id: DOC }, overAllowance)).status).toBe(409)
    expect(overAllowance.calls).toContain('reject')
    expect(overAllowance.status).toBe('queued')
  })

  it('rejects the queued document when it could not be sent to the queue', async () => {
    const deps = fake({
      enqueue: async () => {
        throw new Error('pgmq unavailable')
      },
    })
    await expect(submitDocument({ document_id: DOC }, deps)).rejects.toThrow('pgmq unavailable')
    expect(deps.status).toBe('rejected')
  })
})
