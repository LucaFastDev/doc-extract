import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  allowanceRefusal,
  countPages,
  magicBytesRefusal,
  pageLimitRefusal,
  pagesRemaining,
  sha256Hex,
  sniffType,
} from './checks'

// The checks submit-document makes on an uploaded file (ARCHITECTURE.md section 6.1, PRD US-1.1
// AC-3 and AC-6, OQ-2, OQ-4), as pure functions.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const WEBP = new TextEncoder().encode('RIFF\x24\x00\x00\x00WEBPVP8 ')
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00')

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage()
  return doc.save()
}

describe('sniffType', () => {
  it('recognises PDF, JPEG, PNG and WebP by their magic bytes', async () => {
    expect(sniffType(await pdf(1))).toBe('application/pdf')
    expect(sniffType(JPEG)).toBe('image/jpeg')
    expect(sniffType(PNG)).toBe('image/png')
    expect(sniffType(WEBP)).toBe('image/webp')
  })

  it('recognises nothing else', () => {
    expect(sniffType(GIF)).toBeNull()
    expect(sniffType(new TextEncoder().encode('hello'))).toBeNull()
    expect(sniffType(new TextEncoder().encode('RIFF\x24\x00\x00\x00WAVEfmt '))).toBeNull()
    expect(sniffType(new Uint8Array())).toBeNull()
  })
})

describe('magicBytesRefusal', () => {
  it('accepts a file whose content matches its declared type', async () => {
    expect(magicBytesRefusal('a.pdf', await pdf(1), 'application/pdf')).toBeNull()
    expect(magicBytesRefusal('a.png', PNG, 'image/png')).toBeNull()
    expect(magicBytesRefusal('a.jpg', JPEG, 'image/jpeg')).toBeNull()
    expect(magicBytesRefusal('a.webp', WEBP, 'image/webp')).toBeNull()
  })

  it('refuses content of another type than declared, naming the accepted types', () => {
    expect(magicBytesRefusal('photo.pdf', PNG, 'application/pdf')).toBe(
      'photo.pdf is not a PDF, JPEG, PNG or WebP file, or its content does not match its type. Accepted types: PDF, JPEG, PNG and WebP.',
    )
    expect(magicBytesRefusal('a.png', JPEG, 'image/png')).not.toBeNull()
  })

  it('refuses content that is none of the accepted types', () => {
    expect(magicBytesRefusal('anim.gif', GIF, 'image/png')).not.toBeNull()
    expect(magicBytesRefusal('notes.pdf', new TextEncoder().encode('just text'), 'application/pdf')).not.toBeNull()
  })
})

describe('countPages', () => {
  it('counts the pages of a PDF', async () => {
    expect(await countPages(await pdf(1), 'application/pdf')).toBe(1)
    expect(await countPages(await pdf(10), 'application/pdf')).toBe(10)
    expect(await countPages(await pdf(11), 'application/pdf')).toBe(11)
  })

  it('counts an image as one page (OQ-2)', async () => {
    expect(await countPages(PNG, 'image/png')).toBe(1)
    expect(await countPages(JPEG, 'image/jpeg')).toBe(1)
    expect(await countPages(WEBP, 'image/webp')).toBe(1)
  })

  it('gives null for a PDF it cannot read', async () => {
    expect(await countPages(new TextEncoder().encode('%PDF-1.7\nnot really a pdf'), 'application/pdf')).toBeNull()
  })
})

describe('pageLimitRefusal', () => {
  it('accepts up to 10 pages', () => {
    expect(pageLimitRefusal('a.pdf', 1)).toBeNull()
    expect(pageLimitRefusal('a.pdf', 10)).toBeNull()
  })

  it('refuses more than 10 pages, naming the limit', () => {
    expect(pageLimitRefusal('Statement.pdf', 11)).toBe(
      'Statement.pdf has 11 pages. A document can have at most 10 pages.',
    )
  })
})

describe('sha256Hex', () => {
  it('gives the SHA-256 of the bytes in hex', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('pagesRemaining and allowanceRefusal', () => {
  it('gives the pages left under the lower of the workspace month and the account cap', () => {
    expect(pagesRemaining({ workspace_used: 5, workspace_limit: 20, account_used: 9, account_cap: 10 })).toBe(1)
    expect(pagesRemaining({ workspace_used: 18, workspace_limit: 20, account_used: 0, account_cap: 10 })).toBe(2)
    expect(pagesRemaining({ workspace_used: 25, workspace_limit: 20, account_used: 0, account_cap: 10 })).toBe(0)
  })

  it('says how many pages remain', () => {
    const allowance = { workspace_used: 5, workspace_limit: 20, account_used: 9, account_cap: 10 }
    expect(allowanceRefusal('Invoice.pdf', 3, allowance)).toBe(
      'Invoice.pdf has 3 pages, but only 1 page remains of your page allowance (this workspace’s monthly allowance and your account’s 10-page limit).',
    )
    expect(allowanceRefusal('a.pdf', 2, { ...allowance, account_used: 10 })).toContain('only 0 pages remain')
    expect(allowanceRefusal('a.png', 1, { ...allowance, account_used: 10 })).toContain('a.png has 1 page,')
  })

  // Milestone 5: app_config.account_page_cap null turns the account cap off.
  it('counts only the workspace month when the account cap is off', () => {
    const allowance = { workspace_used: 18, workspace_limit: 20, account_used: 40, account_cap: null }
    expect(pagesRemaining(allowance)).toBe(2)
    expect(allowanceRefusal('Big.pdf', 3, allowance)).toBe(
      'Big.pdf has 3 pages, but only 2 pages remain of this workspace’s monthly page allowance.',
    )
  })
})
