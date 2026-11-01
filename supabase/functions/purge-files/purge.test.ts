import { describe, expect, it, vi } from 'vitest'
import { BATCH_SIZE, purgeFiles, type ExpiredDocument, type PurgeDeps, type StaleUpload } from './purge'

// purge-files (ARCHITECTURE.md section 8, PRD US-14.1, Lead rulings 3 and 5 on #48): files 7 days
// old leave Storage in batches of 100 and get file_deleted_at only when their removal succeeded;
// uploading rows older than an hour give their pages back and go with their objects; stale spend
// reservations are released. The database and Storage are fakes here; tests/access/retention.test.ts
// runs the function against the local stack.

const NOW = new Date('2026-11-10T03:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function expired(n: number, from = 0): ExpiredDocument[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `doc-${String(from + i).padStart(4, '0')}`
    return { id, storage_path: `ws/${id}/original` }
  })
}

/** A fake database and Storage: expired documents ordered by id, as the real query orders them. */
function fakeDeps(o: { expired?: ExpiredDocument[]; stale?: StaleUpload[]; failPaths?: (paths: string[]) => boolean; released?: number } = {}) {
  const rows = [...(o.expired ?? [])].sort((a, b) => a.id.localeCompare(b.id))
  const stale = [...(o.stale ?? [])].sort((a, b) => a.id.localeCompare(b.id))
  const marked: string[] = []
  const removeCalls: string[][] = []
  const selects: { before: Date; afterId: string | null; limit: number }[] = []
  const staleSelects: { before: Date; afterId: string | null; limit: number }[] = []
  const calls: string[] = []
  const deps: PurgeDeps = {
    now: () => NOW,
    async selectExpired(before, afterId, limit) {
      selects.push({ before, afterId, limit })
      return rows.filter((r) => !marked.includes(r.id) && (afterId === null || r.id > afterId)).slice(0, limit)
    },
    async removeObjects(paths) {
      removeCalls.push(paths)
      calls.push(`remove ${paths.join(',')}`)
      return !(o.failPaths?.(paths) ?? false)
    },
    async markFileDeleted(ids, at) {
      expect(at).toEqual(NOW)
      marked.push(...ids)
    },
    async selectStaleUploads(before, afterId, limit) {
      staleSelects.push({ before, afterId, limit })
      return stale.filter((r) => afterId === null || r.id > afterId).slice(0, limit)
    },
    releasePages: vi.fn(async (id: string) => {
      calls.push(`release ${id}`)
    }),
    deleteUpload: vi.fn(async (id: string) => {
      calls.push(`delete ${id}`)
      return true
    }),
    releaseStaleSpend: vi.fn(async () => o.released ?? 0),
  }
  return { deps, marked, removeCalls, selects, staleSelects, calls }
}

describe('batch selection', () => {
  it('selects documents created more than 7 days ago, 100 at a time, each batch after the last id of the one before', async () => {
    const { deps, selects, removeCalls } = fakeDeps({ expired: expired(250) })
    await purgeFiles(deps)
    expect(BATCH_SIZE).toBe(100)
    expect(selects.map((s) => s.before)).toEqual(selects.map(() => new Date(NOW.getTime() - 7 * DAY)))
    expect(selects.map((s) => s.limit)).toEqual([100, 100, 100])
    expect(selects.map((s) => s.afterId)).toEqual([null, 'doc-0099', 'doc-0199'])
    expect(removeCalls.map((paths) => paths.length)).toEqual([100, 100, 50])
  })

  it('stops after the first short batch, and makes no Storage call when nothing is due', async () => {
    const { deps, selects, removeCalls } = fakeDeps()
    expect(await purgeFiles(deps)).toEqual({ files_removed: 0, files_failed: 0, stale_uploads_removed: 0, reservations_released: 0 })
    expect(selects).toHaveLength(1)
    expect(removeCalls).toEqual([])
  })

  it('removes from the documents bucket by storage_path only, the paths of that batch', async () => {
    const { deps, removeCalls } = fakeDeps({ expired: expired(2) })
    await purgeFiles(deps)
    expect(removeCalls).toEqual([['ws/doc-0000/original', 'ws/doc-0001/original']])
  })

  it('moves past a batch that failed, so one bad batch does not stop the run or repeat forever', async () => {
    const { deps, selects } = fakeDeps({ expired: expired(150), failPaths: (paths) => paths.includes('ws/doc-0000/original') })
    await purgeFiles(deps)
    expect(selects.map((s) => s.afterId)).toEqual([null, 'doc-0099'])
  })
})

describe('the result counts', () => {
  it('counts the files removed, the stale uploads removed and the reservations released', async () => {
    const { deps } = fakeDeps({
      expired: expired(120),
      stale: [{ id: 'up-1', storage_path: 'ws/up-1/original', pages_reserved: false, file_deleted_at: null }],
      released: 3,
    })
    expect(await purgeFiles(deps)).toEqual({ files_removed: 120, files_failed: 0, stale_uploads_removed: 1, reservations_released: 3 })
  })

  it('counts a document with no stored path as neither removed nor failed, and marks it', async () => {
    const { deps, marked, removeCalls } = fakeDeps({ expired: [{ id: 'doc-a', storage_path: null }, ...expired(1)] })
    expect(await purgeFiles(deps)).toMatchObject({ files_removed: 1, files_failed: 0 })
    expect(removeCalls).toEqual([['ws/doc-0000/original']])
    expect(marked.sort()).toEqual(['doc-0000', 'doc-a'])
  })
})

describe('a partly failed removal', () => {
  it('sets file_deleted_at only for the batches whose removal succeeded, and counts the rest as failed', async () => {
    // The second batch's Storage call fails; the first and third succeed.
    const { deps, marked } = fakeDeps({ expired: expired(230), failPaths: (paths) => paths.includes('ws/doc-0100/original') })
    expect(await purgeFiles(deps)).toMatchObject({ files_removed: 130, files_failed: 100 })
    expect(marked).toHaveLength(130)
    expect(marked).not.toContain('doc-0100')
    expect(marked).not.toContain('doc-0199')
    expect(marked).toContain('doc-0099')
    expect(marked).toContain('doc-0200')
  })

  it('leaves a failed file for the next run, which removes and marks it', async () => {
    let fail = true
    const { deps, marked } = fakeDeps({ expired: expired(3), failPaths: () => fail })
    expect(await purgeFiles(deps)).toMatchObject({ files_removed: 0, files_failed: 3 })
    expect(marked).toEqual([])
    fail = false
    expect(await purgeFiles(deps)).toMatchObject({ files_removed: 3, files_failed: 0 })
    expect(marked).toHaveLength(3)
  })

  it('counts a batch as failed when marking it fails, and goes on with the next', async () => {
    const { deps } = fakeDeps({ expired: expired(150) })
    const mark = deps.markFileDeleted
    let first = true
    deps.markFileDeleted = async (ids, at) => {
      if (first) {
        first = false
        throw new Error('database down')
      }
      await mark(ids, at)
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await purgeFiles(deps)).toMatchObject({ files_removed: 50, files_failed: 100 })
    error.mockRestore()
  })

  it('counts a Storage call that throws as a failed batch', async () => {
    const { deps } = fakeDeps({ expired: expired(2) })
    deps.removeObjects = async () => {
      throw new Error('network')
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await purgeFiles(deps)).toMatchObject({ files_removed: 0, files_failed: 2 })
    error.mockRestore()
  })
})

describe('stale uploading rows', () => {
  it('selects uploading rows created more than an hour ago, 100 at a time', async () => {
    const stale = Array.from({ length: 101 }, (_, i) => ({
      id: `up-${String(i).padStart(3, '0')}`,
      storage_path: null,
      pages_reserved: false,
      file_deleted_at: null,
    }))
    const { deps, staleSelects } = fakeDeps({ stale })
    expect((await purgeFiles(deps)).stale_uploads_removed).toBe(101)
    expect(staleSelects.map((s) => s.before)).toEqual([new Date(NOW.getTime() - 60 * 60 * 1000), new Date(NOW.getTime() - 60 * 60 * 1000)])
    expect(staleSelects.map((s) => s.afterId)).toEqual([null, 'up-099'])
  })

  it('removes the object, gives the reserved pages back, then removes the row (ruling 3)', async () => {
    const { deps, calls } = fakeDeps({ stale: [{ id: 'up-1', storage_path: 'ws/up-1/original', pages_reserved: true, file_deleted_at: null }] })
    await purgeFiles(deps)
    expect(calls).toEqual(['remove ws/up-1/original', 'release up-1', 'delete up-1'])
  })

  it('releases nothing for a row that holds no pages, and makes no Storage call when there is no file', async () => {
    const { deps, calls } = fakeDeps({ stale: [{ id: 'up-1', storage_path: 'ws/up-1/original', pages_reserved: false, file_deleted_at: '2026-11-01T00:00:00Z' }] })
    await purgeFiles(deps)
    expect(calls).toEqual(['delete up-1'])
  })

  it('keeps the row, pages and all, when its object could not be removed, for the next run', async () => {
    const { deps, calls } = fakeDeps({
      stale: [{ id: 'up-1', storage_path: 'ws/up-1/original', pages_reserved: true, file_deleted_at: null }],
      failPaths: () => true,
    })
    expect((await purgeFiles(deps)).stale_uploads_removed).toBe(0)
    expect(calls).toEqual(['remove ws/up-1/original'])
  })

  it('does not count a row another run or a submit removed or moved on meanwhile', async () => {
    const { deps } = fakeDeps({ stale: [{ id: 'up-1', storage_path: null, pages_reserved: false, file_deleted_at: null }] })
    deps.deleteUpload = async () => false
    expect((await purgeFiles(deps)).stale_uploads_removed).toBe(0)
  })

  it('goes on with the next row when one throws', async () => {
    const { deps } = fakeDeps({
      stale: [
        { id: 'up-1', storage_path: null, pages_reserved: true, file_deleted_at: null },
        { id: 'up-2', storage_path: null, pages_reserved: false, file_deleted_at: null },
      ],
    })
    deps.releasePages = async () => {
      throw new Error('database down')
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await purgeFiles(deps)).stale_uploads_removed).toBe(1)
    error.mockRestore()
  })
})

describe('spend reservations', () => {
  it('releases stale reservations once per run, after the files', async () => {
    const { deps, calls } = fakeDeps({ expired: expired(1), released: 2 })
    const release = deps.releaseStaleSpend as ReturnType<typeof vi.fn>
    release.mockImplementation(async () => {
      calls.push('spend')
      return 2
    })
    expect((await purgeFiles(deps)).reservations_released).toBe(2)
    expect(release).toHaveBeenCalledOnce()
    expect(calls.at(-1)).toBe('spend')
  })
})
