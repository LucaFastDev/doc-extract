import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { zlibSync } from 'fflate'
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import {
  BANK_STATEMENT,
  DELIVERY_NOTE,
  DISCLAIMER,
  INVOICE_DUPLICATE,
  INVOICE_TOTAL_MISMATCH,
  PURCHASE_ORDER,
  QUOTE,
  RECEIPT_PHOTO,
  SAMPLES_DIR,
  type SampleValues,
} from './samples.ts'

// Makes the seven demo samples (issue #41 criterion 1, Lead ruling 2) from the values in
// samples.ts: six PDFs with pdf-lib and the receipt as a PNG, a photographed till receipt drawn
// dot by dot. The output is the same bytes on every run: no dates, no randomness but a seeded one,
// and fflate's deflate for the PNG. Run `npm run demo:samples` to write them to demo/samples/.

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 50
const RIGHT = A4[0] - MARGIN
const INK = rgb(0.13, 0.13, 0.15)
const MUTED = rgb(0.42, 0.42, 0.46)
const RULE = rgb(0.82, 0.82, 0.85)

interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

interface TextOptions {
  size?: number
  bold?: boolean
  color?: RGB
  align?: 'left' | 'right'
}

/** One page being drawn, top down. */
class Sheet {
  readonly page: PDFPage
  readonly fonts: Fonts

  constructor(page: PDFPage, fonts: Fonts) {
    this.page = page
    this.fonts = fonts
  }

  text(text: string, x: number, y: number, { size = 9, bold = false, color = INK, align = 'left' }: TextOptions = {}) {
    const font = bold ? this.fonts.bold : this.fonts.regular
    const left = align === 'right' ? x - font.widthOfTextAtSize(text, size) : x
    this.page.drawText(text, { x: left, y, size, font, color })
  }

  rule(y: number, from = MARGIN, to = RIGHT) {
    this.page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness: 0.6, color: RULE })
  }

  /** Label above value lines, as a party or a meta block prints them. */
  block(label: string, lines: string[], x: number, y: number): number {
    this.text(label.toUpperCase(), x, y, { size: 7.5, bold: true, color: MUTED })
    let at = y - 14
    for (const line of lines) {
      this.text(line, x, at, { size: 9.5 })
      at -= 13
    }
    return at
  }

  /** Label and value pairs, the values right-aligned at `right`. */
  pairs(rows: [string, string][], labelX: number, right: number, y: number, { boldLast = false } = {}): number {
    let at = y
    rows.forEach(([label, value], i) => {
      const bold = boldLast && i === rows.length - 1
      this.text(label, labelX, at, { size: 9.5, bold, color: bold ? INK : MUTED })
      this.text(value, right, at, { size: 9.5, bold, align: 'right' })
      at -= 15
    })
    return at
  }

  footer(note: string, pageLabel?: string) {
    this.rule(62)
    this.text(note, MARGIN, 48, { size: 7.5, color: MUTED })
    this.text(DISCLAIMER, MARGIN, 36, { size: 7.5, color: MUTED })
    if (pageLabel) this.text(pageLabel, RIGHT, 48, { size: 7.5, color: MUTED, align: 'right' })
  }
}

interface Column {
  title: string
  width: number
  align?: 'left' | 'right'
  cell: (line: Record<string, string>) => string
}

/** A table of lines; returns the y below it. */
function table(sheet: Sheet, columns: Column[], lines: Record<string, string>[], y: number): number {
  // Where each column's text starts or, right-aligned, ends; a left column after a right one is set apart.
  const anchors = columns.map((c, i) => {
    const x = MARGIN + columns.slice(0, i).reduce((n, p) => n + p.width, 0)
    if (c.align === 'right') return x + c.width - 4
    return columns[i - 1]?.align === 'right' ? x + 8 : x
  })
  columns.forEach((c, i) => sheet.text(c.title, anchors[i], y, { size: 8, bold: true, color: MUTED, align: c.align }))
  sheet.rule(y - 6)
  let at = y - 22
  for (const line of lines) {
    columns.forEach((c, i) => {
      const value = c.cell(line)
      if (value) sheet.text(value, anchors[i], at, { size: 9, align: c.align })
    })
    sheet.rule(at - 7)
    at -= 20
  }
  return at
}

const money = (amount: string) => (amount ? `EUR ${amount}` : '')

/** A round badge with initials, each company's invented logo. */
function badge(sheet: Sheet, initials: string, color: RGB, x: number, y: number, shape: 'circle' | 'square' | 'diamond') {
  if (shape === 'circle') sheet.page.drawCircle({ x: x + 20, y: y + 20, size: 20, color })
  else if (shape === 'square') sheet.page.drawRectangle({ x, y, width: 40, height: 40, color })
  else sheet.page.drawRectangle({ x: x + 20, y: y - 8, width: 40, height: 40, color, rotate: degrees(45) })
  const width = sheet.fonts.bold.widthOfTextAtSize(initials, 14)
  sheet.text(initials, x + 20 - width / 2, y + 15, { size: 14, bold: true, color: rgb(1, 1, 1) })
}

async function newPdf(title: string): Promise<{ pdf: PDFDocument; fonts: Fonts }> {
  const pdf = await PDFDocument.create({ updateMetadata: false })
  pdf.setTitle(title)
  pdf.setAuthor('doc-extract demo (fictitious)')
  const fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) }
  return { pdf, fonts }
}

const save = (pdf: PDFDocument) => pdf.save({ useObjectStreams: false })

// Invoices -------------------------------------------------------------------------------------

async function invoice(s: SampleValues, reissue: string | null): Promise<Uint8Array> {
  const f = s.fields
  const { pdf, fonts } = await newPdf(`Invoice ${f.invoice_number}`)
  const sheet = new Sheet(pdf.addPage(A4), fonts)

  badge(sheet, 'BP', rgb(0.24, 0.45, 0.3), MARGIN, 752, 'circle')
  sheet.text(f.vendor_name, MARGIN + 52, 778, { size: 13, bold: true })
  sheet.text(f.vendor_address, MARGIN + 52, 763, { size: 9, color: MUTED })
  sheet.text(`VAT no. ${f.vendor_tax_id}`, MARGIN + 52, 751, { size: 9, color: MUTED })
  sheet.text('INVOICE', RIGHT, 770, { size: 22, bold: true, align: 'right' })

  sheet.block('Bill to', [f.customer_name, f.customer_address, `VAT no. ${f.customer_tax_id}`], MARGIN, 700)
  sheet.pairs(
    [
      ['Invoice no.', f.invoice_number],
      ['Invoice date', f.invoice_date],
      ['Due date', f.due_date],
      ['Your PO', f.purchase_order_number],
      ['Payment terms', f.payment_terms],
    ],
    350,
    RIGHT,
    700,
  )

  if (reissue) {
    sheet.page.drawRectangle({ x: 350, y: 588, width: RIGHT - 350, height: 24, borderColor: rgb(0.72, 0.16, 0.16), borderWidth: 1.5 })
    sheet.text(reissue, 360, 596, { size: 10, bold: true, color: rgb(0.72, 0.16, 0.16) })
  }

  const end = table(
    sheet,
    [
      { title: 'Code', width: 72, cell: (l) => l.item_code },
      { title: 'Description', width: 178, cell: (l) => l.description },
      { title: 'Qty', width: 36, align: 'right', cell: (l) => l.quantity },
      { title: 'Unit', width: 40, cell: (l) => l.unit },
      { title: 'Unit price', width: 62, align: 'right', cell: (l) => l.unit_price },
      { title: 'VAT', width: 36, align: 'right', cell: (l) => `${l.tax_rate}%` },
      { title: 'Amount', width: 71, align: 'right', cell: (l) => l.amount },
    ],
    s.lines,
    560,
  )

  const totalsY = sheet.pairs(
    [
      ['Subtotal', money(f.subtotal)],
      ['Discount', money(f.discount_total)],
      ['Shipping', money(f.shipping)],
      ['VAT 19%', money(f.tax_total)],
    ],
    350,
    RIGHT,
    end - 10,
  )
  sheet.rule(totalsY + 7, 350)
  sheet.pairs(
    [
      ['Total', money(f.total)],
      ['Amount due', money(f.amount_due)],
    ],
    350,
    RIGHT,
    totalsY - 8,
    { boldLast: true },
  )

  sheet.text('Please pay by the due date, quoting the invoice number.', MARGIN, 210, { size: 9, color: MUTED })
  if (reissue) sheet.text('This copy replaces the one we sent you on 2026-09-14, whose total was wrong.', MARGIN, 196, { size: 9, color: MUTED })
  sheet.footer(`${f.vendor_name} · ${f.vendor_address}`)
  return save(pdf)
}

// Bank statement -------------------------------------------------------------------------------

async function bankStatement(s: SampleValues): Promise<Uint8Array> {
  const f = s.fields
  const { pdf, fonts } = await newPdf(`Statement ${f.statement_period_start} to ${f.statement_period_end}`)
  const columns: Column[] = [
    { title: 'Date', width: 64, cell: (l) => l.date },
    { title: 'Description', width: 192, cell: (l) => l.description },
    { title: 'Reference', width: 85, cell: (l) => l.reference },
    { title: 'Amount', width: 77, align: 'right', cell: (l) => l.amount },
    { title: 'Balance', width: 77, align: 'right', cell: (l) => l.balance },
  ]
  const firstPage = s.lines.slice(0, 12)
  const secondPage = s.lines.slice(12)
  const footerNote = `${f.bank_name} · 1 Ledger Square, Fernhollow FH1 1AA, Examplia`

  const one = new Sheet(pdf.addPage(A4), fonts)
  badge(one, 'FM', rgb(0.16, 0.28, 0.52), MARGIN, 752, 'square')
  one.text(f.bank_name, MARGIN + 52, 778, { size: 13, bold: true })
  one.text('Business current account', MARGIN + 52, 763, { size: 9, color: MUTED })
  one.text('STATEMENT', RIGHT, 770, { size: 20, bold: true, align: 'right' })

  one.block('Account holder', [f.account_holder, 'Unit 3, 88 Harbour Row', 'Saltmere SM4 9ZZ, Examplia'], MARGIN, 700)
  one.pairs(
    [
      ['Account number', `0000 1234 ${f.account_number_last4}`],
      ['IBAN', `EX00 FHMB 0000 1234 ${f.iban_last4}`],
      ['Period from', f.statement_period_start],
      ['Period to', f.statement_period_end],
      ['Currency', f.currency_as_printed],
    ],
    330,
    RIGHT,
    700,
  )
  one.text('Opening balance', MARGIN, 590, { size: 9.5, bold: true })
  one.text(f.opening_balance, RIGHT - 81, 590, { size: 9.5, bold: true, align: 'right' })
  table(one, columns, firstPage, 560)
  one.text(`Balance carried to page 2: ${firstPage[firstPage.length - 1].balance}`, RIGHT, 92, { size: 8.5, color: MUTED, align: 'right' })
  one.footer(footerNote, 'Page 1 of 2')

  const two = new Sheet(pdf.addPage(A4), fonts)
  two.text(`${f.bank_name} · Statement ${f.statement_period_start} to ${f.statement_period_end}`, MARGIN, 780, { size: 10, bold: true })
  two.text(`Balance brought from page 1: ${firstPage[firstPage.length - 1].balance}`, MARGIN, 762, { size: 8.5, color: MUTED })
  const end = table(two, columns, secondPage, 730)
  two.text('SUMMARY', 330, end - 16, { size: 7.5, bold: true, color: MUTED })
  const summaryEnd = two.pairs(
    [
      ['Opening balance', f.opening_balance],
      ['Total credits', f.total_credits],
      ['Total debits', f.total_debits],
    ],
    330,
    RIGHT,
    end - 32,
  )
  two.rule(summaryEnd + 7, 330)
  two.pairs([['Closing balance', f.closing_balance]], 330, RIGHT, summaryEnd - 8, { boldLast: true })
  two.footer(footerNote, 'Page 2 of 2')
  return save(pdf)
}

// Purchase order and delivery note -------------------------------------------------------------

async function purchaseOrder(s: SampleValues): Promise<Uint8Array> {
  const f = s.fields
  const { pdf, fonts } = await newPdf(`Purchase order ${f.po_number}`)
  const sheet = new Sheet(pdf.addPage(A4), fonts)

  badge(sheet, 'CF', rgb(0.72, 0.42, 0.2), MARGIN - 6, 746, 'diamond')
  sheet.text(f.buyer_name, MARGIN + 52, 778, { size: 13, bold: true })
  sheet.text(f.buyer_address, MARGIN + 52, 763, { size: 9, color: MUTED })
  sheet.text('PURCHASE ORDER', RIGHT, 770, { size: 18, bold: true, align: 'right' })

  sheet.block('Supplier', [f.supplier_name, f.supplier_address], MARGIN, 700)
  sheet.block('Ship to', [f.buyer_name, f.ship_to_address], MARGIN, 640)
  sheet.pairs(
    [
      ['PO number', f.po_number],
      ['Order date', f.order_date],
      ['Deliver by', f.requested_delivery_date],
      ['Payment terms', f.payment_terms],
      ['Currency', f.currency_as_printed],
    ],
    350,
    RIGHT,
    700,
  )

  const end = table(
    sheet,
    [
      { title: 'Item code', width: 80, cell: (l) => l.item_code },
      { title: 'Description', width: 190, cell: (l) => l.description },
      { title: 'Qty', width: 40, align: 'right', cell: (l) => l.quantity },
      { title: 'Unit', width: 40, cell: (l) => l.unit },
      { title: 'Unit price', width: 70, align: 'right', cell: (l) => l.unit_price },
      { title: 'Amount', width: 75, align: 'right', cell: (l) => l.amount },
    ],
    s.lines,
    560,
  )
  const totalsY = sheet.pairs(
    [
      ['Subtotal', f.subtotal],
      ['Shipping', f.shipping],
      ['VAT 19%', f.tax_total],
    ],
    350,
    RIGHT,
    end - 10,
  )
  sheet.rule(totalsY + 7, 350)
  sheet.pairs([['Total EUR', f.total]], 350, RIGHT, totalsY - 8, { boldLast: true })
  sheet.text('Please quote the PO number on your delivery note and invoice.', MARGIN, 210, { size: 9, color: MUTED })
  sheet.text('Authorised by: Purchasing, Copperfinch Design Studio', MARGIN, 196, { size: 9, color: MUTED })
  sheet.footer(`${f.buyer_name} · ${f.buyer_address}`)
  return save(pdf)
}

async function deliveryNote(s: SampleValues): Promise<Uint8Array> {
  const f = s.fields
  const { pdf, fonts } = await newPdf(`Delivery note ${f.delivery_note_number}`)
  const sheet = new Sheet(pdf.addPage(A4), fonts)

  badge(sheet, 'LF', rgb(0.12, 0.5, 0.52), MARGIN, 752, 'circle')
  sheet.text(f.supplier_name, MARGIN + 52, 778, { size: 13, bold: true })
  sheet.text('17 Kiln Yard, Mossgate MG2 7QT, Examplia', MARGIN + 52, 763, { size: 9, color: MUTED })
  sheet.text('DELIVERY NOTE', RIGHT, 770, { size: 18, bold: true, align: 'right' })

  sheet.block('Deliver to', [f.customer_name, f.ship_to_address], MARGIN, 700)
  sheet.pairs(
    [
      ['Delivery note no.', f.delivery_note_number],
      ['Your PO', f.po_number],
      ['Delivery date', f.delivery_date],
      ['Carrier', f.carrier],
      ['Tracking no.', f.tracking_number],
    ],
    330,
    RIGHT,
    700,
  )

  const end = table(
    sheet,
    [
      { title: 'Item code', width: 85, cell: (l) => l.item_code },
      { title: 'Description', width: 220, cell: (l) => l.description },
      { title: 'Ordered', width: 65, align: 'right', cell: (l) => l.quantity_ordered },
      { title: 'Delivered', width: 70, align: 'right', cell: (l) => l.quantity_delivered },
      { title: 'Unit', width: 55, cell: (l) => l.unit },
    ],
    s.lines,
    590,
  )
  sheet.pairs(
    [
      ['Packages', f.total_packages],
      ['Total quantity delivered', f.total_quantity],
    ],
    330,
    RIGHT,
    end - 10,
  )
  sheet.text('Received in good condition by (name and signature):', MARGIN, 230, { size: 9, color: MUTED })
  sheet.rule(200, MARGIN, 300)
  sheet.footer(`${f.supplier_name} · No prices are shown on a delivery note.`)
  return save(pdf)
}

// Quote -----------------------------------------------------------------------------------------

async function quote(s: SampleValues): Promise<Uint8Array> {
  const f = s.fields
  const { pdf, fonts } = await newPdf(`Quote ${f.quote_number}`)
  const sheet = new Sheet(pdf.addPage(A4), fonts)

  badge(sheet, 'SS', rgb(0.15, 0.2, 0.38), MARGIN, 752, 'square')
  sheet.text(f.supplier_name, MARGIN + 52, 778, { size: 13, bold: true })
  sheet.text(f.supplier_address, MARGIN + 52, 763, { size: 9, color: MUTED })
  sheet.text('QUOTE', RIGHT, 770, { size: 22, bold: true, align: 'right' })

  sheet.block('Prepared for', [f.customer_name, f.customer_address], MARGIN, 700)
  sheet.pairs(
    [
      ['Quote no.', f.quote_number],
      ['Quote date', f.quote_date],
      ['Valid until', f.valid_until],
      ['Currency', f.currency_as_printed],
    ],
    350,
    RIGHT,
    700,
  )

  const end = table(
    sheet,
    [
      { title: 'Description', width: 205, cell: (l) => l.description },
      { title: 'Code', width: 70, cell: (l) => l.item_code },
      { title: 'Qty', width: 35, align: 'right', cell: (l) => l.quantity },
      { title: 'Unit', width: 40, cell: (l) => l.unit },
      { title: 'Unit price', width: 70, align: 'right', cell: (l) => l.unit_price },
      { title: 'Amount', width: 75, align: 'right', cell: (l) => l.amount },
    ],
    s.lines,
    600,
  )
  const totalsY = sheet.pairs(
    [
      ['Subtotal', f.subtotal],
      ['Discount 5%', f.discount_total],
      ['VAT 19%', f.tax_total],
    ],
    350,
    RIGHT,
    end - 10,
  )
  sheet.rule(totalsY + 7, 350)
  sheet.pairs([['Total EUR', f.total]], 350, RIGHT, totalsY - 8, { boldLast: true })
  sheet.text(`Payment terms: ${f.payment_terms}`, MARGIN, 230, { size: 9, color: MUTED })
  sheet.text('We look forward to working with you.', MARGIN, 216, { size: 9, color: MUTED })
  sheet.footer(`${f.supplier_name} · ${f.supplier_address}`)
  return save(pdf)
}

// Receipt: a photographed till receipt ----------------------------------------------------------

const WIDTH = 32

/** Left and right text on one receipt line of WIDTH characters. */
const lr = (left: string, right: string) => `${left}${' '.repeat(Math.max(1, WIDTH - left.length - right.length))}${right}`
const centre = (text: string) => `${' '.repeat(Math.floor((WIDTH - text.length) / 2))}${text}`
const DASHES = '-'.repeat(WIDTH)

/** A receipt line, printed faded when `faded` (the ribbon ran dry there). */
interface ReceiptLine {
  text: string
  faded?: boolean
  bold?: boolean
}

/** What the till printed, line by line; samples.test.ts reads the values back from it. */
export function receiptLines(s: SampleValues = RECEIPT_PHOTO): ReceiptLine[] {
  const f = s.fields
  const items = s.lines.flatMap((l) => [{ text: lr(l.description, l.amount) }, { text: `  ${l.quantity} X ${l.unit_price}` }])
  return [
    { text: centre(f.merchant_name), bold: true },
    { text: centre('12 PEBBLE MARKET, BRIGHTWATER,') },
    { text: centre('EXAMPLIA') },
    { text: centre(`VAT ${f.merchant_tax_id}`), faded: true },
    { text: DASHES },
    { text: `RECEIPT ${f.receipt_number}`, faded: true },
    { text: lr(f.transaction_date, f.transaction_time) },
    { text: DASHES },
    ...items,
    { text: DASHES },
    { text: lr('SUBTOTAL', f.subtotal) },
    { text: lr('VAT 10%', f.tax_total) },
    { text: lr('TIP', f.tip) },
    { text: lr(`TOTAL ${f.currency_as_printed}`, f.total), bold: true },
    { text: DASHES },
    { text: lr(`PAID BY ${f.payment_method}`, f.total) },
    { text: `CARD **** **** **** ${f.card_last4}` },
    { text: DASHES },
    { text: centre('THANK YOU - SEE YOU SOON') },
    { text: '' },
    { text: centre('SAMPLE FOR THE DOC-EXTRACT DEMO') },
    { text: centre('ALL DETAILS ARE INVENTED') },
  ]
}

/** A 5 × 7 dot-matrix font: each glyph's rows, # for a dot. */
const GLYPHS: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '###..|#..#.|#...#|#...#|#...#|#..#.|###..',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
  '3': '#####|...#.|..#..|...#.|....#|#...#|.###.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.',
  '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  ',': '.....|.....|.....|.....|.##..|..#..|.#...',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '*': '.....|..#..|#.#.#|.###.|#.#.#|..#..|.....',
  '%': '##...|##..#|...#.|..#..|.#...|#..##|...##',
}

/** A deterministic pseudo-random sequence (a 32-bit LCG), so the photo is the same on every run. */
function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** An 8-bit greyscale PNG of the pixels, row by row. */
function png(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width + 1))
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 0, 0, 0, 0], 8)
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const DOT = 3
const CELL_W = 6
const CELL_H = 10

/** The receipt, photographed on a table: tilted a little, lit unevenly, with paper grain and a shadow. */
function receiptPhoto(): Uint8Array {
  const lines = receiptLines()
  const paperW = WIDTH * CELL_W * DOT + 2 * 36
  const paperH = lines.length * CELL_H * DOT + 2 * 44
  const ink = new Uint8Array(paperW * paperH)
  const random = seeded(41)

  lines.forEach((line, row) => {
    ;[...line.text].forEach((ch, col) => {
      const glyph = GLYPHS[ch]?.split('|')
      if (!glyph) return
      glyph.forEach((dots, gy) => {
        ;[...dots].forEach((d, gx) => {
          if (d !== '#') return
          // A faded line loses dots and prints light; every dot varies a little in strength.
          if (line.faded && random() < 0.15) return
          const strength = (line.faded ? 125 : line.bold ? 215 : 185) + Math.floor(random() * 30)
          const x0 = 36 + (col * CELL_W + gx) * DOT
          const y0 = 44 + (row * CELL_H + gy) * DOT
          for (let dy = 0; dy < DOT - (line.bold ? 0 : 1); dy++) {
            for (let dx = 0; dx < DOT - (line.bold ? 0 : 1); dx++) ink[(y0 + dy) * paperW + x0 + dx] = Math.min(255, strength)
          }
        })
      })
    })
  })

  const width = paperW + 120
  const height = paperH + 130
  const pixels = new Uint8Array(width * height)
  const angle = (-1.6 * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // The paper's own coordinates of this pixel, turned back by the tilt.
      const u = Math.round(cos * (x - cx) + sin * (y - cy) + paperW / 2)
      const v = Math.round(-sin * (x - cx) + cos * (y - cy) + paperH / 2)
      const light = 1 - 0.12 * ((x / width + y / height) / 2)
      const grain = Math.floor(random() * 7) - 3
      let shade: number
      if (u >= 0 && u < paperW && v >= 0 && v < paperH) {
        shade = 236 * light - ink[v * paperW + u] * 0.78 + grain
      } else {
        // The table, darker where the paper's shadow falls below and to the right of it.
        const su = u - 10
        const sv = v - 12
        const outside = Math.max(0, -su, su - paperW, -sv, sv - paperH)
        const shadow = outside < 18 ? 0.55 + (0.45 * outside) / 18 : 1
        shade = 96 * light * shadow + grain
      }
      pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(shade)))
    }
  }
  return png(width, height, pixels)
}

// All of them ------------------------------------------------------------------------------------

/** Every sample's file, by its name in demo/samples/. */
export async function buildSamples(): Promise<Map<string, Uint8Array>> {
  return new Map<string, Uint8Array>([
    [INVOICE_TOTAL_MISMATCH.file, await invoice(INVOICE_TOTAL_MISMATCH, null)],
    [INVOICE_DUPLICATE.file, await invoice(INVOICE_DUPLICATE, 'COPY - REISSUED 2026-09-21')],
    [RECEIPT_PHOTO.file, receiptPhoto()],
    [BANK_STATEMENT.file, await bankStatement(BANK_STATEMENT)],
    [PURCHASE_ORDER.file, await purchaseOrder(PURCHASE_ORDER)],
    [DELIVERY_NOTE.file, await deliveryNote(DELIVERY_NOTE)],
    [QUOTE.file, await quote(QUOTE)],
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(SAMPLES_DIR, { recursive: true })
  for (const [name, bytes] of await buildSamples()) {
    writeFileSync(new URL(name, SAMPLES_DIR), bytes)
    console.log(`demo/samples/${name}: ${bytes.length} bytes`)
  }
}
