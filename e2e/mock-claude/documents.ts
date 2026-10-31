// The files the e2e specs upload, and what the mock Claude server answers for each (ARCHITECTURE.md
// section 9, "How tests mock Claude"). The server tells them apart by the SHA-256 of the file it is
// sent; each answer is a recorded response in supabase/functions/_shared/fixtures/, the same files
// the unit tests use. A file is a PNG's magic bytes and a label: all that submit-document reads of
// an image, and a distinct hash for each.

export interface MockDocument {
  name: string
  mimeType: 'image/png'
  buffer: Buffer
  /** Fixture names, one per call in order; the last repeats. */
  responses: string[]
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]

function document(name: string, label: string, responses: string[]): MockDocument {
  return { name, mimeType: 'image/png', buffer: Buffer.concat([Buffer.from(PNG), Buffer.from(`doc-extract e2e: ${label}`)]), responses }
}

export const MOCK_DOCUMENTS = {
  /** An invoice whose checks pass, with one low-confidence field. */
  invoice: document('Invoice INV-1042.png', 'invoice', ['invoice']),
  /** Not one of the types: record_not_supported. */
  letter: document('Cover letter.png', 'cover letter', ['not-supported']),
  /** A file Claude cannot read: 400, fatal at once. */
  unreadable: document('Unreadable scan.png', 'unreadable', ['error-400']),
  /** Uploaded while the daily ceiling is reached; Claude is never called for it. */
  atTheCeiling: document('Invoice at the ceiling.png', 'at the ceiling', ['invoice']),
  /** Overloaded once, then read: 529, then the invoice. */
  overloadedOnce: document('Invoice when busy.png', 'overloaded once', ['error-529', 'invoice']),
  /** Rate limited once, then read: 429, then the invoice. */
  rateLimitedOnce: document('Invoice when limited.png', 'rate limited once', ['error-429', 'invoice']),
  /** A café receipt that prints only "$": its currency is guessed (OQ-16). */
  receipt: document('Cafe receipt.png', 'receipt', ['receipt']),
  /** A September bank statement whose balances add up. */
  bankStatement: document('Bank statement September.png', 'bank statement', ['bank-statement']),
  /** A purchase order whose checks pass. */
  purchaseOrder: document('Purchase order PO-7731.png', 'purchase order', ['purchase-order']),
  /** A delivery note for that order, with no currency. */
  deliveryNote: document('Delivery note DN-5520.png', 'delivery note', ['delivery-note']),
  /** A quote in German, in CHF. */
  quote: document('Angebot Q-2026-118.png', 'quote', ['quote']),
  /** Another file of the invoice above: its vendor tax id and number printed differently (OQ-9). */
  duplicateInvoice: document('Invoice INV-1042 rescan.png', 'duplicate invoice', ['invoice-duplicate']),
} satisfies Record<string, MockDocument>
