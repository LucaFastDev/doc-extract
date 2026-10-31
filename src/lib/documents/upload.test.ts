import { describe, expect, it } from 'vitest'
import {
  allowanceSummary,
  channelLiveState,
  checkSelection,
  DOC_TYPE_LABELS,
  isListed,
  STATUS_LABELS,
  systemLiveState,
} from './upload'

// The checks the upload control makes before anything is uploaded (PRD US-1.1 AC-2 to AC-4, OQ-4,
// OQ-42), and how the list names statuses and types (US-10.1 AC-1).

const file = (name: string, type: string, size = 1000) => ({ name, type, size })

describe('checkSelection', () => {
  it('accepts up to 10 PDF, JPEG, PNG and WebP files of up to 10 MB', () => {
    expect(
      checkSelection([
        file('a.pdf', 'application/pdf', 10 * 1024 * 1024),
        file('b.jpg', 'image/jpeg'),
        file('c.png', 'image/png'),
        file('d.webp', 'image/webp'),
      ]),
    ).toEqual([])
    expect(checkSelection(Array.from({ length: 10 }, (_, i) => file(`${i}.png`, 'image/png')))).toEqual([])
  })

  it('refuses more than 10 files, naming the limit, whatever they are', () => {
    expect(checkSelection(Array.from({ length: 11 }, (_, i) => file(`${i}.png`, 'image/png')))).toEqual([
      'You can upload at most 10 files at once.',
    ])
  })

  it('refuses another type, naming the accepted types', () => {
    expect(checkSelection([file('a.pdf', 'application/pdf'), file('notes.txt', 'text/plain'), file('x', '')])).toEqual([
      'notes.txt is not a PDF, JPEG, PNG or WebP file. Accepted types: PDF, JPEG, PNG and WebP.',
      'x is not a PDF, JPEG, PNG or WebP file. Accepted types: PDF, JPEG, PNG and WebP.',
    ])
  })

  it('refuses a file over 10 MB, naming the limit, and an empty file', () => {
    expect(
      checkSelection([file('scan.pdf', 'application/pdf', 10 * 1024 * 1024 + 1), file('empty.png', 'image/png', 0)]),
    ).toEqual(['scan.pdf is over the 10 MB limit.', 'empty.png is empty.'])
  })

  it('refuses an empty selection', () => {
    expect(checkSelection([])).toEqual(['Choose at least one file.'])
  })
})

describe('labels', () => {
  it('names every listed status as PRD US-10.1 AC-1 does', () => {
    expect(STATUS_LABELS).toEqual({
      queued: 'Queued',
      processing: 'Processing',
      waiting_budget: 'Waiting for budget',
      needs_review: 'Needs review',
      approved: 'Approved',
      failed: 'Failed',
      unsupported: 'Not supported',
    })
  })

  it('lists neither uploading nor rejected documents', () => {
    expect(isListed('queued')).toBe(true)
    expect(isListed('unsupported')).toBe(true)
    expect(isListed('uploading')).toBe(false)
    expect(isListed('rejected')).toBe(false)
  })

  it('names the six types', () => {
    expect(Object.values(DOC_TYPE_LABELS)).toEqual([
      'Invoice',
      'Receipt',
      'Bank statement',
      'Purchase order',
      'Delivery note',
      'Quote',
    ])
  })
})

describe('live state', () => {
  it('is only joined when the channel subscribes, and reports every other channel status', () => {
    expect(channelLiveState('SUBSCRIBED')).toBe('joined')
    expect(channelLiveState('CHANNEL_ERROR')).toBe('channel_error')
    expect(channelLiveState('TIMED_OUT')).toBe('timed_out')
    expect(channelLiveState('CLOSED')).toBe('closed')
  })

  it('is subscribed once Realtime confirms the postgres_changes subscription', () => {
    expect(systemLiveState({ extension: 'postgres_changes', status: 'ok' })).toBe('subscribed')
  })

  it('is an error when Realtime refuses the subscription in a system message', () => {
    expect(systemLiveState({ extension: 'postgres_changes', status: 'error' })).toBe('channel_error')
    expect(systemLiveState({ extension: 'system', status: 'error' })).toBe('channel_error')
  })

  it('ignores other system messages', () => {
    expect(systemLiveState({ extension: 'system', status: 'ok' })).toBeNull()
    expect(systemLiveState({})).toBeNull()
  })
})

describe('allowanceSummary', () => {
  it('says how many of the account’s pages and the workspace’s pages this month are left', () => {
    expect(allowanceSummary({ workspace_used: 7, workspace_limit: 20, account_used: 9, account_cap: 10 })).toEqual({
      account: '1 of your account’s 10 pages left',
      workspace: '13 of this workspace’s 20 pages left this month',
    })
    expect(allowanceSummary({ workspace_used: 25, workspace_limit: 20, account_used: 0, account_cap: 10 }).workspace).toBe(
      '0 of this workspace’s 20 pages left this month',
    )
  })
})
