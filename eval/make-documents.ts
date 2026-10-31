import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { degrees, PageSizes, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import { GLYPHS, png, seeded } from '../demo/make-samples.ts'
import { LAST4_FIELDS, lastFour } from '../shared/doctypes/fields.ts'
import { DOC_TYPES } from '../shared/doctypes/index.ts'
import { formatDate, formatNumber, formatPercent } from './format.ts'
import type { ExpectedResult } from './score.ts'
import { DISCLAIMER, DOCUMENTS_DIR, EVAL_DOCUMENTS, EXPECTED_DIR, type EvalDocument, type Lang } from './values.ts'

// Makes the 30 eval documents and their expected results (issue #43 criteria 1 and 2) from the
// values in values.ts, the way demo/make-samples.ts makes the demo's: PDFs with pdf-lib and three
// photographed till receipts as PNGs drawn dot by dot. Each type has five layouts, so no two of its
// documents share a template. The output is the same bytes on every run: no dates, no randomness
// but a seeded one. Run `npm run eval:documents` to write eval/documents/ and eval/expected/.

const INK = rgb(0.13, 0.13, 0.15)
const MUTED = rgb(0.42, 0.42, 0.46)
const RULE = rgb(0.8, 0.8, 0.83)
const WHITE = rgb(1, 1, 1)
const BOTTOM = 92

const ACCENT: Record<string, RGB> = {
  invoice: rgb(0.11, 0.42, 0.42),
  quote: rgb(0.17, 0.22, 0.45),
  purchase_order: rgb(0.66, 0.38, 0.16),
  delivery_note: rgb(0.2, 0.45, 0.24),
  bank_statement: rgb(0.14, 0.27, 0.5),
  receipt: rgb(0.45, 0.2, 0.35),
}

/** A lighter tint of a colour, for boxes and bands behind text. */
const tint = (c: RGB, amount: number) => rgb(1 - (1 - c.red) * amount, 1 - (1 - c.green) * amount, 1 - (1 - c.blue) * amount)

// Labels ------------------------------------------------------------------------------------------

const LABELS = {
  en: {
    invoice: 'INVOICE', quote: 'QUOTE', purchase_order: 'PURCHASE ORDER', delivery_note: 'DELIVERY NOTE',
    billTo: 'Bill to', preparedFor: 'Prepared for', supplier: 'Supplier', shipTo: 'Ship to', deliverTo: 'Deliver to',
    invoiceNo: 'Invoice no.', invoiceDate: 'Invoice date', dueDate: 'Due date', poNo: 'PO number', yourPo: 'Your PO',
    terms: 'Payment terms', quoteNo: 'Quote no.', quoteDate: 'Quote date', validUntil: 'Valid until', orderDate: 'Order date',
    deliverBy: 'Deliver by', dnNo: 'Delivery note no.', deliveryDate: 'Delivery date', carrier: 'Carrier', tracking: 'Tracking no.',
    packages: 'Packages', totalQty: 'Total quantity delivered', goodsValue: 'Declared value for insurance',
    code: 'Code', description: 'Description', qty: 'Qty', unit: 'Unit', unitPrice: 'Unit price', rate: 'VAT', amount: 'Amount',
    ordered: 'Ordered', delivered: 'Delivered', subtotal: 'Subtotal', discount: 'Discount', shipping: 'Shipping', tax: 'VAT',
    total: 'Total', paid: 'Amount paid', due: 'Amount due', page: 'Page', of: 'of', continued: 'continued', taxId: 'VAT no.',
    thanks: 'Thank you for your business.', currency: 'Currency',
  },
  de: {
    invoice: 'RECHNUNG', quote: 'ANGEBOT', purchase_order: 'BESTELLUNG', delivery_note: 'LIEFERSCHEIN',
    billTo: 'Rechnungsempfänger', preparedFor: 'Angebot für', supplier: 'Lieferant', shipTo: 'Lieferadresse', deliverTo: 'Empfänger',
    invoiceNo: 'Rechnungsnummer', invoiceDate: 'Rechnungsdatum', dueDate: 'Fällig am', poNo: 'Bestellnummer', yourPo: 'Ihre Bestellung',
    terms: 'Zahlungsbedingungen', quoteNo: 'Angebotsnummer', quoteDate: 'Angebotsdatum', validUntil: 'Gültig bis', orderDate: 'Bestelldatum',
    deliverBy: 'Liefertermin', dnNo: 'Lieferschein-Nr.', deliveryDate: 'Lieferdatum', carrier: 'Spediteur', tracking: 'Sendungsnummer',
    packages: 'Packstücke', totalQty: 'Gesamtmenge geliefert', goodsValue: 'Warenwert',
    code: 'Art.-Nr.', description: 'Bezeichnung', qty: 'Menge', unit: 'Einheit', unitPrice: 'Einzelpreis', rate: 'MwSt.', amount: 'Betrag',
    ordered: 'Bestellt', delivered: 'Geliefert', subtotal: 'Zwischensumme', discount: 'Rabatt', shipping: 'Versand', tax: 'MwSt.',
    total: 'Gesamtbetrag', paid: 'Anzahlung', due: 'Zu zahlen', page: 'Seite', of: 'von', continued: 'Fortsetzung', taxId: 'USt-IdNr.',
    thanks: 'Vielen Dank für Ihren Auftrag.', currency: 'Währung',
  },
  fr: {
    invoice: 'FACTURE', quote: 'DEVIS', purchase_order: 'BON DE COMMANDE', delivery_note: 'BON DE LIVRAISON',
    billTo: 'Facturer à', preparedFor: 'Devis pour', supplier: 'Fournisseur', shipTo: 'Livrer à', deliverTo: 'Livrer à',
    invoiceNo: 'N° de facture', invoiceDate: 'Date de facture', dueDate: 'Échéance', poNo: 'N° de commande', yourPo: 'Votre commande',
    terms: 'Conditions de paiement', quoteNo: 'N° de devis', quoteDate: 'Date du devis', validUntil: 'Valable jusqu’au', orderDate: 'Date de commande',
    deliverBy: 'Livraison souhaitée', dnNo: 'N° de bon de livraison', deliveryDate: 'Date de livraison', carrier: 'Transporteur', tracking: 'N° de suivi',
    packages: 'Colis', totalQty: 'Quantité totale livrée', goodsValue: 'Valeur déclarée',
    code: 'Réf.', description: 'Désignation', qty: 'Qté', unit: 'Unité', unitPrice: 'Prix unitaire', rate: 'TVA', amount: 'Montant',
    ordered: 'Commandé', delivered: 'Livré', subtotal: 'Total HT', discount: 'Remise', shipping: 'Frais de port', tax: 'TVA',
    total: 'Total TTC', paid: 'Acompte versé', due: 'Reste à payer', page: 'Page', of: 'sur', continued: 'suite', taxId: 'N° TVA',
    thanks: 'Merci de votre confiance.', currency: 'Devise',
  },
  es: {
    invoice: 'FACTURA', quote: 'PRESUPUESTO', purchase_order: 'PEDIDO DE COMPRA', delivery_note: 'ALBARÁN',
    billTo: 'Facturar a', preparedFor: 'Presupuesto para', supplier: 'Proveedor', shipTo: 'Enviar a', deliverTo: 'Entregar a',
    invoiceNo: 'N.º de factura', invoiceDate: 'Fecha de factura', dueDate: 'Vencimiento', poNo: 'N.º de pedido', yourPo: 'Su pedido',
    terms: 'Condiciones de pago', quoteNo: 'N.º de presupuesto', quoteDate: 'Fecha', validUntil: 'Válido hasta', orderDate: 'Fecha del pedido',
    deliverBy: 'Entrega solicitada', dnNo: 'N.º de albarán', deliveryDate: 'Fecha de entrega', carrier: 'Transportista', tracking: 'N.º de seguimiento',
    packages: 'Bultos', totalQty: 'Cantidad total entregada', goodsValue: 'Valor declarado',
    code: 'Código', description: 'Descripción', qty: 'Cant.', unit: 'Unidad', unitPrice: 'Precio unitario', rate: 'IVA', amount: 'Importe',
    ordered: 'Pedido', delivered: 'Entregado', subtotal: 'Base imponible', discount: 'Descuento', shipping: 'Portes', tax: 'IVA',
    total: 'Total', paid: 'Pagado', due: 'Pendiente', page: 'Página', of: 'de', continued: 'continuación', taxId: 'NIF',
    thanks: 'Gracias por su confianza.', currency: 'Moneda',
  },
  nl: {
    invoice: 'FACTUUR', quote: 'OFFERTE', purchase_order: 'INKOOPORDER', delivery_note: 'PAKBON',
    billTo: 'Factuuradres', preparedFor: 'Offerte voor', supplier: 'Leverancier', shipTo: 'Afleveradres', deliverTo: 'Afleveren bij',
    invoiceNo: 'Factuurnummer', invoiceDate: 'Factuurdatum', dueDate: 'Vervaldatum', poNo: 'Ordernummer', yourPo: 'Uw order',
    terms: 'Betalingsvoorwaarden', quoteNo: 'Offertenummer', quoteDate: 'Offertedatum', validUntil: 'Geldig tot', orderDate: 'Orderdatum',
    deliverBy: 'Gewenste leverdatum', dnNo: 'Pakbonnummer', deliveryDate: 'Leverdatum', carrier: 'Vervoerder', tracking: 'Trackingnummer',
    packages: 'Colli', totalQty: 'Totaal geleverd', goodsValue: 'Goederenwaarde',
    code: 'Artikelnr.', description: 'Omschrijving', qty: 'Aantal', unit: 'Eenheid', unitPrice: 'Prijs per eenheid', rate: 'BTW', amount: 'Bedrag',
    ordered: 'Besteld', delivered: 'Geleverd', subtotal: 'Subtotaal', discount: 'Korting', shipping: 'Verzendkosten', tax: 'BTW',
    total: 'Totaal', paid: 'Betaald', due: 'Te betalen', page: 'Pagina', of: 'van', continued: 'vervolg', taxId: 'Btw-nr.',
    thanks: 'Bedankt voor uw order.', currency: 'Valuta',
  },
  it: {
    invoice: 'FATTURA', quote: 'PREVENTIVO', purchase_order: 'ORDINE DI ACQUISTO', delivery_note: 'DOCUMENTO DI TRASPORTO',
    billTo: 'Intestatario', preparedFor: 'Preventivo per', supplier: 'Fornitore', shipTo: 'Spedire a', deliverTo: 'Destinatario',
    invoiceNo: 'Fattura n.', invoiceDate: 'Data fattura', dueDate: 'Scadenza', poNo: 'Ordine n.', yourPo: 'Vostro ordine',
    terms: 'Condizioni di pagamento', quoteNo: 'Preventivo n.', quoteDate: 'Data', validUntil: 'Valido fino al', orderDate: 'Data ordine',
    deliverBy: 'Consegna richiesta', dnNo: 'DDT n.', deliveryDate: 'Data di consegna', carrier: 'Vettore', tracking: 'N. tracking',
    packages: 'Colli', totalQty: 'Quantità totale consegnata', goodsValue: 'Valore dichiarato',
    code: 'Codice', description: 'Descrizione', qty: 'Q.tà', unit: 'Unità', unitPrice: 'Prezzo unitario', rate: 'IVA', amount: 'Importo',
    ordered: 'Ordinato', delivered: 'Consegnato', subtotal: 'Imponibile', discount: 'Sconto', shipping: 'Spedizione', tax: 'IVA',
    total: 'Totale', paid: 'Pagato', due: 'Da pagare', page: 'Pagina', of: 'di', continued: 'segue', taxId: 'P. IVA',
    thanks: 'Grazie per la fiducia.', currency: 'Valuta',
  },
} satisfies Record<Lang, Record<string, string>>

type Labels = (typeof LABELS)['en']

/** The labels of a document's language, with the US and Swiss names for tax where they differ. */
function labels(doc: EvalDocument): Labels {
  const l = LABELS[doc.style.lang]
  if (doc.fields.currency === 'USD') return { ...l, tax: 'Sales tax', rate: 'Tax', taxId: 'Tax ID' }
  if (doc.fields.currency === 'CHF') return { ...l, tax: 'MWST', rate: 'MWST', taxId: 'MWST-Nr.' }
  return l
}

// Printing values ---------------------------------------------------------------------------------

/** Bank statement layouts that print money out and money in in two columns, unsigned. */
const SPLIT_LAYOUTS = new Set([2, 4])

/** How a document prints a stored value of one of its fields; documents.test.ts looks for it in the text. */
export function printedValue(doc: EvalDocument, name: string, value: string): string {
  const def = DOC_TYPES[doc.docType]
  const kind = [...def.fields, ...def.lineFields].find((f) => f.name === name)?.kind
  if (kind === 'date') return formatDate(value, doc.style.date)
  if (kind === 'amount' || kind === 'number' || kind === 'percent') {
    const unsigned = doc.docType === 'bank_statement' && name === 'amount' && SPLIT_LAYOUTS.has(doc.style.layout)
    return formatNumber(unsigned ? value.replace(/^-/, '') : value, doc.style.number)
  }
  return value
}

const dateOf = (doc: EvalDocument, iso: string) => (iso ? formatDate(iso, doc.style.date) : '')
const numberOf = (doc: EvalDocument, decimal: string) => (decimal ? formatNumber(decimal, doc.style.number) : '')

/** An amount with the currency as printed, before or after it as the document's style says. */
function moneyOf(doc: EvalDocument, decimal: string): string {
  const n = numberOf(doc, decimal)
  const c = doc.fields.currency_as_printed
  if (!n || doc.style.currency === 'none' || !c) return n
  return doc.style.currency === 'before' ? `${c} ${n}` : `${n} ${c}`
}

// Drawing -----------------------------------------------------------------------------------------

type Family = 'helvetica' | 'times' | 'courier'

const FONTS: Record<Family, [StandardFonts, StandardFonts]> = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold],
}

interface TextOptions {
  size?: number
  bold?: boolean
  color?: RGB
  align?: 'left' | 'right' | 'center'
  /** Shrinks the text until it fits. */
  maxWidth?: number
}

/** A PDF being drawn, page by page, top down. */
class Draw {
  readonly pages: PDFPage[] = []
  page!: PDFPage
  readonly pdf: PDFDocument
  readonly regular: PDFFont
  readonly bold: PDFFont
  readonly size: [number, number]

  private constructor(pdf: PDFDocument, regular: PDFFont, bold: PDFFont, size: [number, number]) {
    this.pdf = pdf
    this.regular = regular
    this.bold = bold
    this.size = size
  }

  static async create(title: string, size: [number, number], family: Family): Promise<Draw> {
    const pdf = await PDFDocument.create({ updateMetadata: false })
    pdf.setTitle(title)
    pdf.setAuthor('doc-extract eval (fictitious)')
    const [regular, bold] = FONTS[family]
    const d = new Draw(pdf, await pdf.embedFont(regular), await pdf.embedFont(bold), size)
    d.addPage()
    return d
  }

  get width() {
    return this.size[0]
  }

  get height() {
    return this.size[1]
  }

  addPage() {
    this.page = this.pdf.addPage(this.size)
    this.pages.push(this.page)
  }

  measure(text: string, size: number, bold = false) {
    return (bold ? this.bold : this.regular).widthOfTextAtSize(text, size)
  }

  text(text: string, x: number, y: number, { size = 9, bold = false, color = INK, align = 'left', maxWidth }: TextOptions = {}) {
    if (!text) return
    let s = size
    while (maxWidth && s > 5.5 && this.measure(text, s, bold) > maxWidth) s -= 0.25
    const w = this.measure(text, s, bold)
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x
    this.page.drawText(text, { x: left, y, size: s, font: bold ? this.bold : this.regular, color })
  }

  rule(y: number, from: number, to: number, { color = RULE, thickness = 0.6, dashed = false } = {}) {
    this.page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness, color, dashArray: dashed ? [2, 2] : undefined })
  }

  box(x: number, y: number, width: number, height: number, color: RGB, border?: RGB) {
    this.page.drawRectangle({ x, y, width, height, color, borderColor: border, borderWidth: border ? 0.8 : 0 })
  }

  /** Label and value pairs: labels in one column, values left-aligned after the widest label. */
  pairs(rows: [string, string][], x: number, right: number, y: number, size = 9.5): number {
    const labelWidth = Math.max(0, ...rows.map(([l]) => this.measure(l, size)))
    let at = y
    for (const [label, value] of rows) {
      this.text(label, x, at, { size, color: MUTED })
      this.text(value, x + labelWidth + 10, at, { size, maxWidth: right - x - labelWidth - 10 })
      at -= size + 5
    }
    return at
  }

  /** The disclaimer and page numbers on every page. */
  footers(lang: Lang, margin: number) {
    const l = LABELS[lang]
    this.pages.forEach((page, i) => {
      this.page = page
      this.rule(58, margin, this.width - margin)
      this.text(DISCLAIMER[lang], margin, 40, { size: 7, color: MUTED, maxWidth: this.width - 2 * margin - 70 })
      if (this.pages.length > 1) this.text(`${l.page} ${i + 1} ${l.of} ${this.pages.length}`, this.width - margin, 40, { size: 7, color: MUTED, align: 'right' })
    })
  }

  save() {
    return this.pdf.save({ useObjectStreams: false })
  }
}

interface Column {
  title: string
  key: string
  weight: number
  align?: 'left' | 'right'
  format: (value: string) => string
}

interface TableStyle {
  zebra?: RGB
  header?: RGB
  dashed?: boolean
  size?: number
  /** Draws what a continuation page carries before its table: a title line, a sidebar. */
  onNewPage: () => number
}

/** A table that flows onto new pages; columns whose every cell is empty are left out. Returns the y below it. */
function table(d: Draw, all: Column[], rows: Record<string, string>[], y: number, x0: number, x1: number, style: TableStyle): number {
  const columns = all.filter((c) => rows.some((r) => r[c.key]))
  const total = columns.reduce((n, c) => n + c.weight, 0)
  const widths = columns.map((c) => ((x1 - x0) * c.weight) / total)
  const lefts = widths.map((_, i) => x0 + widths.slice(0, i).reduce((n, w) => n + w, 0))
  const size = style.size ?? 9
  const cellX = (i: number) => (columns[i].align === 'right' ? lefts[i] + widths[i] - 4 : lefts[i] + 4)

  const header = (at: number) => {
    if (style.header) d.box(x0, at - 6, x1 - x0, 18, style.header)
    columns.forEach((c, i) => d.text(c.title, cellX(i), at, { size: size - 1, bold: true, color: style.header ? WHITE : MUTED, align: c.align, maxWidth: widths[i] - 6 }))
    d.rule(at - 7, x0, x1, { dashed: style.dashed })
    return at - 22
  }

  let at = header(y)
  rows.forEach((row, r) => {
    if (at < BOTTOM + 10) {
      d.addPage()
      at = header(style.onNewPage())
    }
    if (style.zebra && r % 2 === 1) d.box(x0, at - 6, x1 - x0, 19, style.zebra)
    columns.forEach((c, i) => d.text(c.format(row[c.key] ?? ''), cellX(i), at, { size, align: c.align, maxWidth: widths[i] - 8 }))
    d.rule(at - 7, x0, x1, { dashed: style.dashed })
    at -= 20
  })
  return at
}

/** A badge with initials: each company's invented logo. */
function badge(d: Draw, initials: string, color: RGB, x: number, y: number, shape: 'circle' | 'square' | 'diamond') {
  if (shape === 'circle') d.page.drawCircle({ x: x + 20, y: y + 20, size: 20, color })
  else if (shape === 'square') d.box(x, y, 40, 40, color)
  else d.page.drawRectangle({ x: x + 20, y: y - 8, width: 40, height: 40, color, rotate: degrees(45) })
  d.text(initials, x + 20, y + 15, { size: 14, bold: true, color: WHITE, align: 'center' })
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-ZÀ-Ý]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('')

// Commercial documents: invoice, quote, purchase order, delivery note -----------------------------

interface Party {
  label: string
  lines: string[]
}

interface TotalRow {
  label: string
  value: string
  bold?: boolean
}

interface Commercial {
  title: string
  issuer: { name: string; lines: string[] }
  parties: Party[]
  meta: [string, string][]
  columns: Column[]
  /** The columns' order, by key, for each layout. */
  order: Record<number, string[]>
  totals: TotalRow[]
  notes: string[]
}

const nonEmpty = <T extends [string, string]>(rows: T[]) => rows.filter(([, v]) => v)

/** Draws a commercial document in its layout: 1 logo left, 2 band, 3 letterhead, 4 typewriter, 5 sidebar. */
async function commercial(doc: EvalDocument, c: Commercial): Promise<Uint8Array> {
  const layout = doc.style.layout
  const family: Family = layout === 4 ? 'courier' : layout === 5 ? 'times' : 'helvetica'
  const d = await Draw.create(`${c.title} ${c.meta[0]?.[1] ?? ''}`.trim(), layout === 3 ? PageSizes.Letter : PageSizes.A4, family)
  const accent = ACCENT[doc.docType]
  const M = 50
  const right = d.width - M
  const top = d.height - 50
  const left = layout === 5 ? 200 : M
  const sidebar = () => d.box(0, 0, 170, d.height, tint(accent, 0.12))
  const continuation = () => {
    if (layout === 5) sidebar()
    d.text(`${c.title} ${c.meta[0][1]} (${LABELS[doc.style.lang].continued})`, left, top, { size: 10, bold: true })
    return top - 34
  }
  const party = (p: Party, x: number, y: number, width: number) => {
    d.text(p.label.toUpperCase(), x, y, { size: 7.5, bold: true, color: MUTED })
    let at = y - 14
    for (const line of p.lines.filter(Boolean)) {
      d.text(line, x, at, { size: 9.5, maxWidth: width })
      at -= 13
    }
    return at
  }
  const columns = c.order[layout].map((key) => c.columns.find((col) => col.key === key)!)
  let y: number

  if (layout === 1) {
    badge(d, initials(c.issuer.name), accent, M, top - 38, 'circle')
    d.text(c.issuer.name, M + 52, top - 12, { size: 13, bold: true, maxWidth: 260 })
    c.issuer.lines.forEach((line, i) => d.text(line, M + 52, top - 27 - i * 12, { size: 9, color: MUTED, maxWidth: 260 }))
    d.text(c.title, right, top - 20, { size: 20, bold: true, align: 'right', maxWidth: 200 })
    let partyY = top - 90
    for (const p of c.parties) partyY = party(p, M, partyY, 260) - 12
    const metaY = d.pairs(c.meta, 330, right, top - 90)
    y = Math.min(partyY, metaY) - 16
  } else if (layout === 2) {
    d.box(0, d.height - 100, d.width, 100, accent)
    d.text(c.title, M, d.height - 62, { size: 24, bold: true, color: WHITE, maxWidth: 280 })
    d.text(c.issuer.name, right, d.height - 40, { size: 12, bold: true, color: WHITE, align: 'right', maxWidth: 260 })
    c.issuer.lines.forEach((line, i) => d.text(line, right, d.height - 56 - i * 12, { size: 8.5, color: WHITE, align: 'right', maxWidth: 260 }))
    const gap = 14
    const width = (right - M - gap * (c.parties.length - 1)) / c.parties.length
    let lowest = d.height - 130
    c.parties.forEach((p, i) => {
      const x = M + i * (width + gap)
      d.box(x, d.height - 200, width, 80, tint(accent, 0.1))
      lowest = Math.min(lowest, party(p, x + 10, d.height - 136, width - 20))
    })
    const boxW = (right - M) / c.meta.length
    c.meta.forEach(([label, value], i) => {
      const x = M + i * boxW
      d.box(x, d.height - 262, boxW - 4, 44, WHITE, RULE)
      d.text(label, x + 6, d.height - 234, { size: 7, color: MUTED, maxWidth: boxW - 14 })
      d.text(value, x + 6, d.height - 250, { size: 9, bold: true, maxWidth: boxW - 14 })
    })
    y = d.height - 290
  } else if (layout === 3) {
    d.text(c.issuer.name, d.width / 2, top - 8, { size: 16, bold: true, align: 'center', maxWidth: d.width - 2 * M })
    c.issuer.lines.forEach((line, i) => d.text(line, d.width / 2, top - 24 - i * 12, { size: 9, color: MUTED, align: 'center', maxWidth: d.width - 2 * M }))
    const ruleY = top - 30 - c.issuer.lines.length * 12
    d.rule(ruleY, M, right, { color: accent, thickness: 1.2 })
    d.rule(ruleY - 3, M, right, { color: accent, thickness: 0.5 })
    d.text(c.title, M, ruleY - 30, { size: 18, bold: true, color: accent })
    let partyY = ruleY - 58
    for (const p of c.parties) partyY = party(p, M, partyY, 250) - 10
    const metaY = d.pairs(c.meta, 320, right, ruleY - 58, 9)
    y = Math.min(partyY, metaY) - 14
  } else if (layout === 4) {
    d.text(c.title, M, top - 22, { size: 24, bold: true, maxWidth: 300 })
    d.text(c.issuer.name, right, top - 4, { size: 10, bold: true, align: 'right', maxWidth: 240 })
    c.issuer.lines.forEach((line, i) => d.text(line, right, top - 18 - i * 11, { size: 8, align: 'right', maxWidth: 260 }))
    d.rule(top - 50, M, right, { dashed: true, color: INK })
    let partyY = top - 72
    for (const p of c.parties) partyY = party(p, M, partyY, 300) - 10
    const metaY = d.pairs(c.meta, M, right, partyY - 6, 9)
    d.rule(metaY + 4, M, right, { dashed: true, color: INK })
    y = metaY - 16
  } else {
    sidebar()
    badge(d, initials(c.issuer.name), accent, 24, top - 40, 'square')
    let at = top - 74
    for (const [label, value] of c.meta) {
      d.text(label.toUpperCase(), 24, at, { size: 7, bold: true, color: MUTED, maxWidth: 130 })
      d.text(value, 24, at - 13, { size: 10, maxWidth: 130 })
      at -= 34
    }
    d.text(c.title, right, top - 6, { size: 18, bold: true, color: accent, align: 'right', maxWidth: 200 })
    d.text(c.issuer.name, left, top - 36, { size: 13, bold: true, maxWidth: right - left })
    c.issuer.lines.forEach((line, i) => d.text(line, left, top - 50 - i * 12, { size: 9, color: MUTED, maxWidth: right - left }))
    let partyY = top - 100
    for (const p of c.parties) partyY = party(p, left, partyY, right - left) - 10
    y = partyY - 8
  }

  y = table(d, columns, doc.lines, y, left, right, {
    zebra: layout === 3 ? tint(accent, 0.08) : undefined,
    header: layout === 2 ? accent : undefined,
    dashed: layout === 4,
    size: layout === 4 ? 8 : 9,
    onNewPage: continuation,
  })

  const height = c.totals.length * 15 + 30 + c.notes.length * 13
  if (y - height < BOTTOM) {
    d.addPage()
    y = continuation()
  }
  if (c.totals.length > 0) {
    const x = layout === 4 ? left : right - 220
    const valueX = layout === 4 ? left + 260 : right
    if (layout === 2) d.box(x - 10, y - c.totals.length * 15 - 2, right - x + 10, c.totals.length * 15 + 12, tint(accent, 0.1))
    let at = y - 6
    for (const t of c.totals) {
      if (t.bold) d.rule(at + 11, x, valueX, { color: layout === 4 ? INK : RULE, dashed: layout === 4 })
      d.text(t.label, x, at, { size: 9.5, bold: t.bold, color: t.bold ? INK : MUTED })
      d.text(t.value, valueX - 4, at, { size: 9.5, bold: t.bold, align: 'right' })
      at -= 15
    }
    y = at - 10
  }
  c.notes.forEach((note, i) => d.text(note, left, y - i * 13, { size: 9, color: MUTED, maxWidth: right - left }))
  d.footers(doc.style.lang, M)
  return d.save()
}

function cellColumns(doc: EvalDocument, l: Labels): Column[] {
  const text = (v: string) => v
  const num = (v: string) => numberOf(doc, v)
  return [
    { key: 'item_code', title: l.code, weight: 1.1, format: text },
    { key: 'description', title: l.description, weight: 3, format: text },
    { key: 'quantity', title: l.qty, weight: 0.7, align: 'right', format: num },
    { key: 'unit', title: l.unit, weight: 0.8, format: text },
    { key: 'unit_price', title: l.unitPrice, weight: 1.1, align: 'right', format: num },
    { key: 'tax_rate', title: l.rate, weight: 0.7, align: 'right', format: (v) => (v ? formatPercent(v, doc.style.number) : '') },
    { key: 'amount', title: l.amount, weight: 1.2, align: 'right', format: num },
    { key: 'quantity_ordered', title: l.ordered, weight: 1, align: 'right', format: num },
    { key: 'quantity_delivered', title: l.delivered, weight: 1, align: 'right', format: num },
  ]
}

const PRICED_ORDER: Record<number, string[]> = {
  1: ['item_code', 'description', 'quantity', 'unit', 'unit_price', 'tax_rate', 'amount'],
  2: ['description', 'item_code', 'quantity', 'unit', 'unit_price', 'tax_rate', 'amount'],
  3: ['quantity', 'unit', 'item_code', 'description', 'unit_price', 'tax_rate', 'amount'],
  4: ['description', 'quantity', 'unit', 'unit_price', 'tax_rate', 'amount', 'item_code'],
  5: ['item_code', 'description', 'unit', 'quantity', 'unit_price', 'tax_rate', 'amount'],
}

const taxLabel = (doc: EvalDocument, l: Labels) => `${l.tax} ${formatPercent(doc.extra.rate, doc.style.number)}`

function invoice(doc: EvalDocument): Promise<Uint8Array> {
  const f = doc.fields
  const l = labels(doc)
  const totals: TotalRow[] = [
    { label: l.subtotal, value: moneyOf(doc, f.subtotal) },
    { label: l.discount, value: moneyOf(doc, f.discount_total) },
    { label: l.shipping, value: moneyOf(doc, f.shipping) },
    { label: taxLabel(doc, l), value: moneyOf(doc, f.tax_total) },
    { label: l.total, value: moneyOf(doc, f.total), bold: true },
    ...(f.amount_paid ? [{ label: l.paid, value: moneyOf(doc, f.amount_paid) }] : []),
    { label: l.due, value: moneyOf(doc, f.amount_due), bold: true },
  ]
  return commercial(doc, {
    title: l.invoice,
    issuer: { name: f.vendor_name, lines: [f.vendor_address, f.vendor_tax_id && `${l.taxId} ${f.vendor_tax_id}`] },
    parties: [{ label: l.billTo, lines: [f.customer_name, f.customer_address, f.customer_tax_id && `${l.taxId} ${f.customer_tax_id}`] }],
    meta: nonEmpty([
      [l.invoiceNo, f.invoice_number],
      [l.invoiceDate, dateOf(doc, f.invoice_date)],
      [l.dueDate, dateOf(doc, f.due_date)],
      [l.yourPo, f.purchase_order_number],
      [l.terms, f.payment_terms],
    ]),
    columns: cellColumns(doc, l),
    order: PRICED_ORDER,
    totals,
    notes: [l.thanks],
  })
}

function quote(doc: EvalDocument): Promise<Uint8Array> {
  const f = doc.fields
  const l = labels(doc)
  const discount = doc.extra.discountRate ? `${l.discount} ${formatPercent(doc.extra.discountRate, doc.style.number)}` : l.discount
  return commercial(doc, {
    title: l.quote,
    issuer: { name: f.supplier_name, lines: [f.supplier_address] },
    parties: [{ label: l.preparedFor, lines: [f.customer_name, f.customer_address] }],
    meta: nonEmpty([
      [l.quoteNo, f.quote_number],
      [l.quoteDate, dateOf(doc, f.quote_date)],
      [l.validUntil, dateOf(doc, f.valid_until)],
      [l.terms, f.payment_terms],
    ]),
    columns: cellColumns(doc, l),
    order: PRICED_ORDER,
    totals: [
      { label: l.subtotal, value: moneyOf(doc, f.subtotal) },
      { label: discount, value: moneyOf(doc, f.discount_total) },
      { label: taxLabel(doc, l), value: moneyOf(doc, f.tax_total) },
      { label: l.total, value: moneyOf(doc, f.total), bold: true },
    ],
    notes: [l.thanks],
  })
}

function purchaseOrder(doc: EvalDocument): Promise<Uint8Array> {
  const f = doc.fields
  const l = labels(doc)
  return commercial(doc, {
    title: l.purchase_order,
    issuer: { name: f.buyer_name, lines: [f.buyer_address] },
    parties: [
      { label: l.supplier, lines: [f.supplier_name, f.supplier_address] },
      { label: l.shipTo, lines: [f.ship_to_address] },
    ],
    meta: nonEmpty([
      [l.poNo, f.po_number],
      [l.orderDate, dateOf(doc, f.order_date)],
      [l.deliverBy, dateOf(doc, f.requested_delivery_date)],
      [l.terms, f.payment_terms],
    ]),
    columns: cellColumns(doc, l),
    order: PRICED_ORDER,
    totals: [
      { label: l.subtotal, value: moneyOf(doc, f.subtotal) },
      { label: l.shipping, value: moneyOf(doc, f.shipping) },
      { label: taxLabel(doc, l), value: moneyOf(doc, f.tax_total) },
      { label: l.total, value: moneyOf(doc, f.total), bold: true },
    ],
    notes: [],
  })
}

function deliveryNote(doc: EvalDocument): Promise<Uint8Array> {
  const f = doc.fields
  const l = labels(doc)
  const notes: string[] = []
  if (doc.extra.goodsValue) {
    const n = numberOf(doc, doc.extra.goodsValue)
    notes.push(`${l.goodsValue}: ${doc.style.lang === 'en' ? `${f.currency_as_printed} ${n}` : `${n} ${f.currency_as_printed}`}`)
  }
  return commercial(doc, {
    title: l.delivery_note,
    issuer: { name: f.supplier_name, lines: [doc.extra.supplierAddress] },
    parties: [{ label: l.deliverTo, lines: [f.customer_name, f.ship_to_address] }],
    meta: nonEmpty([
      [l.dnNo, f.delivery_note_number],
      [l.yourPo, f.po_number],
      [l.deliveryDate, dateOf(doc, f.delivery_date)],
      [l.carrier, f.carrier],
      [l.tracking, f.tracking_number],
    ]),
    columns: cellColumns(doc, l),
    order: {
      1: ['item_code', 'description', 'quantity_ordered', 'quantity_delivered', 'unit'],
      2: ['item_code', 'description', 'unit', 'quantity_ordered', 'quantity_delivered'],
      3: ['description', 'item_code', 'quantity_ordered', 'quantity_delivered', 'unit'],
      4: ['description', 'quantity_delivered', 'unit', 'item_code', 'quantity_ordered'],
      5: ['quantity_delivered', 'quantity_ordered', 'unit', 'item_code', 'description'],
    },
    totals: [
      { label: l.packages, value: numberOf(doc, f.total_packages) },
      ...(f.total_quantity ? [{ label: l.totalQty, value: numberOf(doc, f.total_quantity), bold: true }] : []),
    ],
    notes,
  })
}

// Bank statements ---------------------------------------------------------------------------------

const BANK_LABELS = {
  en: {
    title: 'STATEMENT', holder: 'Account holder', account: 'Account number', iban: 'IBAN', from: 'Period from', to: 'Period to',
    opening: 'Opening balance', closing: 'Closing balance', date: 'Date', description: 'Description', reference: 'Reference',
    amount: 'Amount', out: 'Money out', in: 'Money in', balance: 'Balance', credits: 'Total credits', debits: 'Total debits',
    carried: 'Balance carried forward', summary: 'SUMMARY', currency: 'Currency',
  },
  de: {
    title: 'KONTOAUSZUG', holder: 'Kontoinhaber', account: 'Kontonummer', iban: 'IBAN', from: 'Zeitraum vom', to: 'bis',
    opening: 'Alter Kontostand', closing: 'Neuer Kontostand', date: 'Buchungstag', description: 'Verwendungszweck', reference: 'Referenz',
    amount: 'Betrag', out: 'Soll', in: 'Haben', balance: 'Saldo', credits: 'Summe Haben', debits: 'Summe Soll',
    carried: 'Übertrag', summary: 'ÜBERSICHT', currency: 'Währung',
  },
  fr: {
    title: 'RELEVÉ DE COMPTE', holder: 'Titulaire', account: 'N° de compte', iban: 'IBAN', from: 'Du', to: 'Au',
    opening: 'Ancien solde', closing: 'Nouveau solde', date: 'Date', description: 'Libellé', reference: 'Référence',
    amount: 'Montant', out: 'Débit', in: 'Crédit', balance: 'Solde', credits: 'Total des crédits', debits: 'Total des débits',
    carried: 'Solde reporté', summary: 'RÉCAPITULATIF', currency: 'Devise',
  },
}

/** Rows of a bank statement on each page, by layout. */
const ROWS_PER_PAGE: Record<number, number> = { 1: 12, 2: 20, 3: 20, 4: 14, 5: 20 }

async function bankStatement(doc: EvalDocument): Promise<Uint8Array> {
  const f = doc.fields
  const b = BANK_LABELS[doc.style.lang as 'en' | 'de' | 'fr']
  const layout = doc.style.layout
  const split = SPLIT_LAYOUTS.has(layout)
  const family: Family = layout === 4 ? 'courier' : layout === 5 ? 'times' : 'helvetica'
  const d = await Draw.create(`${b.title} ${f.statement_period_start} ${f.statement_period_end}`, layout === 5 ? PageSizes.Letter : PageSizes.A4, family)
  const accent = ACCENT.bank_statement
  const M = 50
  const right = d.width - M
  const top = d.height - 50
  const num = (v: string) => numberOf(doc, v)
  const daily = layout === 5

  const columns: Column[] = [
    { key: 'date', title: b.date, weight: 1, format: (v) => dateOf(doc, v) },
    { key: 'description', title: b.description, weight: 3, format: (v) => v },
    { key: 'reference', title: b.reference, weight: 1.4, format: (v) => v },
    ...(split
      ? [
          { key: 'out', title: b.out, weight: 1.1, align: 'right' as const, format: num },
          { key: 'in', title: b.in, weight: 1.1, align: 'right' as const, format: num },
        ]
      : [{ key: 'amount', title: b.amount, weight: 1.2, align: 'right' as const, format: num }]),
    { key: 'balance', title: daily ? 'Daily balance' : b.balance, weight: 1.2, align: 'right', format: num },
  ]
  const rows = doc.lines.map((l) => ({
    ...l,
    out: l.amount.startsWith('-') ? l.amount.slice(1) : '',
    in: l.amount.startsWith('-') ? '' : l.amount,
  }))

  const account = [
    [b.account, doc.extra.accountNumber],
    [b.iban, doc.extra.iban],
    [b.from, dateOf(doc, f.statement_period_start)],
    [b.to, dateOf(doc, f.statement_period_end)],
    [b.currency, f.currency_as_printed],
  ].filter(([, v]) => v) as [string, string][]

  let y: number
  if (layout === 1 || layout === 4) {
    badge(d, initials(f.bank_name), accent, M, top - 38, 'square')
    d.text(f.bank_name, M + 52, top - 12, { size: 13, bold: true })
    d.text(doc.extra.bankAddress, M + 52, top - 27, { size: 8.5, color: MUTED, maxWidth: 280 })
    d.text(b.title, right, top - 20, { size: layout === 4 ? 16 : 20, bold: true, align: 'right' })
    d.text(b.holder.toUpperCase(), M, top - 90, { size: 7.5, bold: true, color: MUTED })
    d.text(f.account_holder, M, top - 104, { size: 9.5 })
    d.text(doc.extra.holderAddress, M, top - 117, { size: 9.5, maxWidth: 250 })
    y = Math.min(top - 140, d.pairs(account, 320, right, top - 90) - 10)
  } else if (layout === 2) {
    d.box(0, d.height - 96, d.width, 96, accent)
    d.text(f.bank_name, M, d.height - 50, { size: 16, bold: true, color: WHITE })
    d.text(doc.extra.bankAddress, M, d.height - 68, { size: 8.5, color: WHITE })
    d.text(b.title, right, d.height - 50, { size: 14, bold: true, color: WHITE, align: 'right' })
    d.box(M, d.height - 190, 230, 76, tint(accent, 0.1))
    d.text(b.holder.toUpperCase(), M + 10, d.height - 130, { size: 7.5, bold: true, color: MUTED })
    d.text(f.account_holder, M + 10, d.height - 145, { size: 9.5 })
    d.text(doc.extra.holderAddress, M + 10, d.height - 158, { size: 8.5, maxWidth: 210 })
    y = Math.min(d.height - 210, d.pairs(account, 310, right, d.height - 130) - 10)
  } else if (layout === 3) {
    d.text(f.bank_name, d.width / 2, top - 6, { size: 15, bold: true, align: 'center' })
    d.text(doc.extra.bankAddress, d.width / 2, top - 21, { size: 8.5, color: MUTED, align: 'center' })
    d.rule(top - 32, M, right, { color: accent, thickness: 1.2 })
    d.text(b.title, M, top - 58, { size: 16, bold: true, color: accent })
    d.text(`${f.account_holder} · ${doc.extra.holderAddress}`, M, top - 78, { size: 9, maxWidth: right - M })
    d.text(account.map(([l, v]) => `${l} ${v}`).join('   '), M, top - 94, { size: 8.5, color: MUTED, maxWidth: right - M })
    y = top - 120
  } else {
    d.box(0, 0, 160, d.height, tint(accent, 0.12))
    badge(d, initials(f.bank_name), accent, 24, top - 40, 'circle')
    let at = top - 72
    for (const [label, value] of account) {
      d.text(label.toUpperCase(), 24, at, { size: 7, bold: true, color: MUTED })
      d.text(value, 24, at - 13, { size: 9.5, maxWidth: 125 })
      at -= 32
    }
    d.text(f.bank_name, 190, top - 10, { size: 14, bold: true })
    d.text(doc.extra.bankAddress, 190, top - 25, { size: 8.5, color: MUTED, maxWidth: right - 190 })
    d.text(b.title, right, top - 52, { size: 13, bold: true, align: 'right' })
    d.text(f.account_holder, 190, top - 72, { size: 10 })
    d.text(doc.extra.holderAddress, 190, top - 85, { size: 9, maxWidth: right - 190 })
    y = top - 112
  }

  const x0 = layout === 5 ? 190 : M
  d.text(b.opening, x0, y, { size: 9.5, bold: true })
  d.text(num(f.opening_balance), right - 4, y, { size: 9.5, bold: true, align: 'right' })
  y -= 24

  const perPage = ROWS_PER_PAGE[layout]
  for (let start = 0; start < rows.length; start += perPage) {
    const chunk = rows.slice(start, start + perPage)
    if (start > 0) {
      d.addPage()
      if (layout === 5) d.box(0, 0, 160, d.height, tint(accent, 0.12))
      d.text(`${f.bank_name} · ${b.title} ${dateOf(doc, f.statement_period_start)} - ${dateOf(doc, f.statement_period_end)}`, x0, top, { size: 10, bold: true })
      y = top - 30
    }
    y = table(d, columns, chunk, y, x0, right, {
      header: layout === 2 ? accent : undefined,
      zebra: layout === 3 ? tint(accent, 0.07) : undefined,
      dashed: layout === 4,
      size: layout === 4 ? 7.5 : 8.5,
      onNewPage: () => top - 30,
    })
    const more = start + perPage < rows.length
    const lastBalance = chunk.map((r) => r.balance).filter(Boolean).pop()
    if (more && lastBalance) d.text(`${b.carried}: ${num(lastBalance)}`, right, y - 2, { size: 8.5, color: MUTED, align: 'right' })
  }

  const summary: TotalRow[] = [
    ...(f.total_credits ? [{ label: b.credits, value: num(f.total_credits) }] : []),
    ...(f.total_debits ? [{ label: b.debits, value: num(f.total_debits) }] : []),
    { label: b.closing, value: num(f.closing_balance), bold: true },
  ]
  if (y - summary.length * 15 - 40 < BOTTOM) {
    d.addPage()
    y = top - 10
  }
  let at = y - 14
  d.text(b.summary, right - 230, at, { size: 7.5, bold: true, color: MUTED })
  at -= 16
  for (const s of summary) {
    if (s.bold) d.rule(at + 11, right - 230, right)
    d.text(s.label, right - 230, at, { size: 9.5, bold: s.bold, color: s.bold ? INK : MUTED })
    d.text(s.value, right - 4, at, { size: 9.5, bold: s.bold, align: 'right' })
    at -= 15
  }
  d.footers(doc.style.lang, M)
  return d.save()
}

// Receipts: three photographed till rolls and two PDFs --------------------------------------------

/** A receipt line, printed faded when the ribbon ran dry there. */
export interface ReceiptLine {
  text: string
  faded?: boolean
  bold?: boolean
}

/** The glyphs the demo's font lacks. */
const MORE_GLYPHS: Record<string, string> = {
  '/': '....#|...#.|...#.|..#..|.#...|.#...|#....',
  '@': '.###.|#...#|#.###|#.#.#|#.###|#....|.####',
}
const DOTS = { ...GLYPHS, ...MORE_GLYPHS }

/** What a photographed till printed, line by line; documents.test.ts reads the values back from it. */
export function receiptLines(doc: EvalDocument): ReceiptLine[] {
  const f = doc.fields
  const width = { 1: 32, 2: 30, 3: 40 }[doc.style.layout as 1 | 2 | 3]
  const n = (v: string) => numberOf(doc, v)
  const lr = (a: string, b: string) => `${a}${' '.repeat(Math.max(1, width - a.length - b.length))}${b}`
  const centre = (t: string) => `${' '.repeat(Math.max(0, Math.floor((width - t.length) / 2)))}${t}`
  const dashes = { text: '-'.repeat(width) }
  const date = dateOf(doc, f.transaction_date)
  const head = [
    { text: centre(f.merchant_name), bold: true },
    ...f.merchant_address.split(', ').reduce<string[]>((rows, part) => {
      const last = rows[rows.length - 1]
      if (last !== undefined && `${last}, ${part}`.length <= width) rows[rows.length - 1] = `${last}, ${part}`
      else rows.push(part)
      return rows
    }, []).map((t, i, all) => ({ text: centre(i < all.length - 1 ? `${t},` : t) })),
  ]

  if (doc.style.layout === 1) {
    return [
      ...head,
      { text: centre(`VAT ${f.merchant_tax_id}`), faded: true },
      dashes,
      { text: `RECEIPT ${f.receipt_number}` },
      { text: lr(date, f.transaction_time) },
      dashes,
      ...doc.lines.flatMap((l) => [{ text: lr(l.description, n(l.amount)) }, { text: `  ${n(l.quantity)} X ${n(l.unit_price)}` }]),
      dashes,
      { text: lr('SUBTOTAL', n(f.subtotal)) },
      { text: lr(`VAT ${n(doc.extra.rate)}%`, n(f.tax_total)) },
      { text: lr('TIP', n(f.tip)) },
      { text: lr(`TOTAL ${f.currency_as_printed}`, n(f.total)), bold: true },
      dashes,
      { text: lr(`PAID BY ${f.payment_method}`, n(f.total)) },
      { text: `CARD **** **** **** ${f.card_last4}` },
      dashes,
      { text: centre('THANK YOU AND SEE YOU SOON') },
      { text: '' },
      { text: centre('FICTITIOUS RECEIPT FOR THE') },
      { text: centre('DOC-EXTRACT EVAL - ALL INVENTED') },
    ]
  }
  if (doc.style.layout === 2) {
    return [
      ...head,
      { text: centre(`STEUER-NR. ${f.merchant_tax_id}`) },
      dashes,
      { text: lr(`BON-NR. ${f.receipt_number}`, '') },
      { text: lr(date, f.transaction_time), faded: true },
      dashes,
      ...doc.lines.flatMap((l) => [{ text: `${n(l.quantity)} X ${n(l.unit_price)}` }, { text: lr(l.description, n(l.amount)) }]),
      dashes,
      { text: lr('ZWISCHENSUMME', n(f.subtotal)) },
      { text: lr(`MWST ${n(doc.extra.rate)}%`, n(f.tax_total)) },
      { text: lr('TRINKGELD', n(f.tip)) },
      { text: lr(`SUMME ${f.currency_as_printed}`, n(f.total)), bold: true },
      { text: lr(f.payment_method, n(f.total)) },
      dashes,
      { text: centre('VIELEN DANK') },
      { text: '' },
      { text: centre('FIKTIVER BELEG FUER DIE') },
      { text: centre('DOC-EXTRACT-AUSWERTUNG') },
      { text: centre('ALLE ANGABEN ERFUNDEN') },
    ]
  }
  return [
    ...head,
    { text: centre(`VAT NO ${f.merchant_tax_id}`) },
    dashes,
    { text: lr(`TABLE 12   CHECK ${f.receipt_number}`, '') },
    { text: lr(date, f.transaction_time) },
    dashes,
    ...doc.lines.map((l) => ({ text: lr(`${n(l.quantity)} ${l.description} @ ${n(l.unit_price)}`, n(l.amount)) })),
    dashes,
    { text: lr('SUBTOTAL', n(f.subtotal)) },
    { text: lr(`VAT ${n(doc.extra.rate)}%`, n(f.tax_total)), faded: true },
    { text: lr('TIP', n(f.tip)) },
    { text: lr(`TOTAL ${f.currency_as_printed}`, n(f.total)), bold: true },
    dashes,
    { text: lr(f.payment_method, n(f.total)) },
    { text: `CARD ************${f.card_last4}` },
    dashes,
    { text: centre('FICTITIOUS BILL FOR THE DOC-EXTRACT EVAL') },
    { text: centre('ALL DETAILS ARE INVENTED') },
  ]
}

const DOT = 3
const CELL_W = 6
const CELL_H = 10

interface Photo {
  tilt: number
  seed: number
  /** The light falling on the scene, from 0 to 1, at a point given as fractions of the width and height. */
  light: (x: number, y: number) => number
  paper: number
  table: number
}

const PHOTOS: Record<1 | 2 | 3, Photo> = {
  1: { tilt: -1.6, seed: 43, light: (x, y) => 1 - 0.12 * ((x + y) / 2), paper: 236, table: 96 },
  2: { tilt: 2.4, seed: 44, light: (x, y) => 1.02 - 0.18 * Math.hypot(x - 0.2, y - 0.15), paper: 230, table: 120 },
  3: { tilt: -2, seed: 45, light: (x, y) => 0.86 - 0.16 * y + 0.05 * x, paper: 226, table: 70 },
}

/** The till roll, photographed on a table: tilted, lit unevenly, with paper grain and a shadow. */
function receiptPhoto(doc: EvalDocument): Uint8Array {
  const lines = receiptLines(doc)
  const p = PHOTOS[doc.style.layout as 1 | 2 | 3]
  const columns = Math.max(...lines.map((l) => l.text.length))
  const paperW = columns * CELL_W * DOT + 2 * 36
  const paperH = lines.length * CELL_H * DOT + 2 * 44
  const ink = new Uint8Array(paperW * paperH)
  const random = seeded(p.seed)

  lines.forEach((line, row) => {
    ;[...line.text].forEach((ch, col) => {
      const glyph = DOTS[ch]?.split('|')
      if (!glyph) return
      glyph.forEach((dots, gy) => {
        ;[...dots].forEach((dot, gx) => {
          if (dot !== '#') return
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

  const width = paperW + 140
  const height = paperH + 150
  const pixels = new Uint8Array(width * height)
  const angle = (p.tilt * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = Math.round(cos * (x - width / 2) + sin * (y - height / 2) + paperW / 2)
      const v = Math.round(-sin * (x - width / 2) + cos * (y - height / 2) + paperH / 2)
      const light = p.light(x / width, y / height)
      const grain = Math.floor(random() * 7) - 3
      let shade: number
      if (u >= 0 && u < paperW && v >= 0 && v < paperH) {
        shade = p.paper * light - ink[v * paperW + u] * 0.78 + grain
      } else {
        const su = u - 10
        const sv = v - 12
        const outside = Math.max(0, -su, su - paperW, -sv, sv - paperH)
        const shadow = outside < 18 ? 0.55 + (0.45 * outside) / 18 : 1
        shade = p.table * light * shadow + grain
      }
      pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(shade)))
    }
  }
  return png(width, height, pixels)
}

const RECEIPT_LABELS = {
  fr: { title: 'REÇU', no: 'Course n°', time: 'Heure', subtotal: 'Total HT', tax: 'TVA', tip: 'Pourboire', total: 'Total TTC', paid: 'Payé par', taxId: 'N° TVA', qty: 'x' },
  en: { title: 'RECEIPT', no: 'Order', time: 'Time', subtotal: 'Subtotal', tax: 'Sales tax', tip: 'Tip', total: 'Total', paid: 'Paid with', taxId: 'Tax ID', qty: 'x' },
}

/** A taxi's narrow printed receipt (layout 4) or a restaurant's e-receipt (layout 5), as a PDF. */
async function receiptPdf(doc: EvalDocument): Promise<Uint8Array> {
  const f = doc.fields
  const r = RECEIPT_LABELS[doc.style.lang as 'fr' | 'en']
  const accent = ACCENT.receipt
  const money = (v: string) => moneyOf(doc, v)
  const tax = `${r.tax} ${formatPercent(doc.extra.rate, doc.style.number)}`

  if (doc.style.layout === 4) {
    const d = await Draw.create(`${r.title} ${f.receipt_number}`, [227, 470], 'helvetica')
    const W = 227
    let y = 440
    const line = (a: string, b = '', bold = false) => {
      d.text(a, 14, y, { size: 8, bold, maxWidth: b ? 130 : W - 28 })
      if (b) d.text(b, W - 14, y, { size: 8, bold, align: 'right' })
      y -= 13
    }
    d.text(f.merchant_name, W / 2, y, { size: 11, bold: true, align: 'center' })
    y -= 14
    d.text(f.merchant_address, W / 2, y, { size: 6.5, align: 'center', maxWidth: W - 20 })
    y -= 11
    d.text(`${r.taxId} ${f.merchant_tax_id}`, W / 2, y, { size: 6.5, align: 'center', color: MUTED })
    y -= 20
    d.text(r.title, W / 2, y, { size: 12, bold: true, align: 'center', color: accent })
    y -= 18
    line(`${r.no} ${f.receipt_number}`)
    line(dateOf(doc, f.transaction_date), `${r.time} ${f.transaction_time}`)
    d.rule(y + 6, 14, W - 14, { dashed: true, color: INK })
    y -= 6
    for (const l of doc.lines) {
      line(l.description, money(l.amount))
      line(`  ${numberOf(doc, l.quantity)} ${r.qty} ${money(l.unit_price)}`)
    }
    d.rule(y + 6, 14, W - 14, { dashed: true, color: INK })
    y -= 6
    line(r.subtotal, money(f.subtotal))
    line(tax, money(f.tax_total))
    line(r.tip, money(f.tip))
    line(r.total, money(f.total), true)
    y -= 6
    line(`${r.paid} ${f.payment_method}`)
    line(`**** **** **** ${f.card_last4}`)
    y -= 10
    d.text('Merci et bonne route !', W / 2, y, { size: 8, align: 'center' })
    d.text(DISCLAIMER.fr, W / 2, 24, { size: 5, color: MUTED, align: 'center', maxWidth: W - 16 })
    return d.save()
  }

  const d = await Draw.create(`${r.title} ${f.receipt_number}`, PageSizes.A5, 'helvetica')
  const W = d.width
  const M = 36
  d.box(0, d.height - 80, W, 80, accent)
  d.text(f.merchant_name, M, d.height - 44, { size: 16, bold: true, color: WHITE })
  d.text('Your pickup receipt', M, d.height - 62, { size: 9, color: WHITE })
  let y = d.height - 110
  d.pairs(
    [
      [r.no, f.receipt_number],
      ['Picked up', `${dateOf(doc, f.transaction_date)} at ${f.transaction_time}`],
    ],
    M,
    W - M,
    y,
  )
  y -= 50
  y = table(
    d,
    [
      { key: 'description', title: 'Item', weight: 3, format: (v) => v },
      { key: 'quantity', title: 'Qty', weight: 0.7, align: 'right', format: (v) => numberOf(doc, v) },
      { key: 'unit_price', title: 'Price', weight: 1.1, align: 'right', format: (v) => numberOf(doc, v) },
      { key: 'amount', title: 'Amount', weight: 1.2, align: 'right', format: (v) => numberOf(doc, v) },
    ],
    doc.lines,
    y,
    M,
    W - M,
    { onNewPage: () => d.height - 60 },
  )
  const rows: TotalRow[] = [
    { label: r.subtotal, value: money(f.subtotal) },
    { label: tax, value: money(f.tax_total) },
    { label: r.tip, value: money(f.tip) },
    { label: r.total, value: money(f.total), bold: true },
  ]
  let at = y - 6
  for (const t of rows) {
    if (t.bold) d.rule(at + 11, W - M - 180, W - M)
    d.text(t.label, W - M - 180, at, { size: 9.5, bold: t.bold, color: t.bold ? INK : MUTED })
    d.text(t.value, W - M - 4, at, { size: 9.5, bold: t.bold, align: 'right' })
    at -= 15
  }
  d.text(`${r.paid} ${f.payment_method} ending in ${f.card_last4}`, M, at - 14, { size: 9 })
  d.text(f.merchant_address, M, 70, { size: 8, color: MUTED, maxWidth: W - 2 * M })
  d.rule(58, M, W - M)
  d.text(DISCLAIMER.en, M, 40, { size: 6.5, color: MUTED, maxWidth: W - 2 * M })
  return d.save()
}

// All of them -------------------------------------------------------------------------------------

/** One document's file. */
export function buildDocument(doc: EvalDocument): Promise<Uint8Array> | Uint8Array {
  switch (doc.docType) {
    case 'invoice':
      return invoice(doc)
    case 'quote':
      return quote(doc)
    case 'purchase_order':
      return purchaseOrder(doc)
    case 'delivery_note':
      return deliveryNote(doc)
    case 'bank_statement':
      return bankStatement(doc)
    case 'receipt':
      return doc.file.endsWith('.png') ? receiptPhoto(doc) : receiptPdf(doc)
  }
}

/** Every document's file, by its name in eval/documents/. */
export async function buildDocuments(): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const doc of EVAL_DOCUMENTS) out.set(doc.file, await buildDocument(doc))
  return out
}

const LAST4 = new Set<string>(LAST4_FIELDS)

/**
 * A document's expected result: every field and line-item cell of its type, in the order the app
 * stores them, as stored: null when not printed, a card or account number as its last four (OQ-29).
 */
export function expectedResult(doc: EvalDocument): ExpectedResult {
  const def = DOC_TYPES[doc.docType]
  const stored = (name: string, value: string | undefined, where: string) => {
    if (value === undefined) throw new Error(`${doc.file}: ${where} has no value in values.ts`)
    return value === '' ? null : LAST4.has(name) ? lastFour(value) : value
  }
  return {
    document: doc.file,
    doc_type: doc.docType,
    fields: [
      ...def.fields.map((f) => ({ path: f.name, kind: f.kind, value: stored(f.name, doc.fields[f.name], f.name) })),
      ...doc.lines.flatMap((line, i) =>
        def.lineFields.map((f) => ({ path: `line_items[${i}].${f.name}`, kind: f.kind, value: stored(f.name, line[f.name], `line ${i + 1} ${f.name}`) })),
      ),
    ],
  }
}

/** The expected result's file in eval/expected/. */
export const expectedFile = (doc: EvalDocument) => `${doc.file.replace(/\.[a-z]+$/, '')}.json`

export const expectedJson = (doc: EvalDocument) => `${JSON.stringify(expectedResult(doc), null, 2)}\n`

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(DOCUMENTS_DIR, { recursive: true })
  mkdirSync(EXPECTED_DIR, { recursive: true })
  for (const doc of EVAL_DOCUMENTS) {
    const bytes = await buildDocument(doc)
    writeFileSync(new URL(doc.file, DOCUMENTS_DIR), bytes)
    writeFileSync(new URL(expectedFile(doc), EXPECTED_DIR), expectedJson(doc))
    console.log(`eval/documents/${doc.file}: ${bytes.length} bytes; eval/expected/${expectedFile(doc)}`)
  }
}
