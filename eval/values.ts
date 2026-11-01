import type { DocType } from '../shared/doctypes/index.ts'
import type { DateStyle, NumberStyle } from './format.ts'

// What the 30 eval documents print (PRD F16 AC-1, OQ-26; issue #43 criteria 1 and 2): 5 per type,
// every value of every field and line as the app stores it, with '' for a field the document does
// not print. make-documents.ts draws each document from its entry and writes its expected result
// to eval/expected/; documents.test.ts checks the files against both. Every name, address and
// number is invented: "Examplia" (and its forms in other languages, Examplien, Exemplie, Ejemplia,
// Exemplië, Esemplia) is no real country, and "EX" no real country code.
//
// Totals are worked out here from the lines with exact cents, so every printed total adds up; the
// tests run each type's checks over every expected result to prove it.

export type Lang = 'en' | 'de' | 'fr' | 'es' | 'nl' | 'it'

export interface PrintStyle {
  lang: Lang
  date: DateStyle
  number: NumberStyle
  /** The layout of the type's renderer, 1 to 5: no two documents of a type share one. */
  layout: 1 | 2 | 3 | 4 | 5
  /** Where currency_as_printed goes beside an amount, or nowhere when the document names it once. */
  currency: 'before' | 'after' | 'none'
}

export interface EvalDocument {
  /** The file name in eval/documents/; its expected result is eval/expected/<name>.json. */
  file: string
  docType: DocType
  /** What the document is and what sets it apart. */
  note: string
  style: PrintStyle
  /** Every header field of the type, as the app stores it. */
  fields: Record<string, string>
  /** Each line's cells, a bank statement's transactions among them. */
  lines: Record<string, string>[]
  /** Printed text that is no field: a tax rate, a supplier's address, a full account number. */
  extra: Record<string, string>
}

// Exact money ------------------------------------------------------------------------------------

const scaled = (s: string): [bigint, bigint] => {
  const [whole, fraction = ''] = s.replace('-', '').split('.')
  const units = BigInt(whole + fraction)
  return [s.startsWith('-') ? -units : units, 10n ** BigInt(fraction.length)]
}

/** n / d rounded half away from zero. */
const divide = (n: bigint, d: bigint) => {
  const r = ((n < 0n ? -n : n) * 2n + d) / (2n * d)
  return n < 0n ? -r : r
}

const cents = (s: string) => {
  const [units, scale] = scaled(s)
  return divide(units * 100n, scale)
}

const money = (c: bigint) => {
  const a = c < 0n ? -c : c
  return `${c < 0n ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

const plus = (...values: string[]) => money(values.reduce((t, v) => t + cents(v), 0n))
const minus = (a: string, b: string) => money(cents(a) - cents(b))

/** quantity × unit price, to the cent. */
const times = (quantity: string, price: string) => {
  const [q, scale] = scaled(quantity)
  return money(divide(cents(price) * q, scale))
}

/** rate % of an amount, to the cent. */
const percentOf = (amount: string, rate: string) => {
  const [r, scale] = scaled(rate)
  return money(divide(cents(amount) * r, 100n * scale))
}

// Commercial documents ---------------------------------------------------------------------------

type Priced = { item_code: string; description: string; quantity: string; unit: string; unit_price: string }

const item = (item_code: string, description: string, quantity: string, unit: string, unit_price: string): Priced => ({
  item_code,
  description,
  quantity,
  unit,
  unit_price,
})

const withAmounts = (lines: Priced[]) => lines.map((l) => ({ ...l, amount: times(l.quantity, l.unit_price) }))

/** Subtotal, tax on (subtotal − discount + shipping), total. */
function totals(lines: { amount: string }[], rate: string, discount: string, shipping: string) {
  const subtotal = plus(...lines.map((l) => l.amount))
  const tax_total = percentOf(plus(minus(subtotal, discount), shipping), rate)
  return { subtotal, discount_total: discount, shipping, tax_total, total: plus(minus(subtotal, discount), shipping, tax_total) }
}

const LANGUAGE = (lang: Lang) => ({ language: lang })

// Invoices ---------------------------------------------------------------------------------------

function invoice(o: {
  file: string
  note: string
  style: PrintStyle
  currency: string
  printed: string
  parties: Record<string, string>
  meta: Record<string, string>
  lines: Priced[]
  /** The rate printed on each line, or '' when the document has no tax column. */
  lineRate: string
  rate: string
  discount: string
  shipping: string
  paid: string
}): EvalDocument {
  const lines = withAmounts(o.lines).map((l) => ({ ...l, tax_rate: o.lineRate }))
  const t = totals(lines, o.rate, o.discount, o.shipping)
  return {
    file: o.file,
    docType: 'invoice',
    note: o.note,
    style: o.style,
    fields: {
      ...LANGUAGE(o.style.lang),
      currency: o.currency,
      currency_as_printed: o.printed,
      ...o.parties,
      ...o.meta,
      subtotal: t.subtotal,
      tax_total: t.tax_total,
      shipping: t.shipping,
      discount_total: t.discount_total,
      total: t.total,
      amount_paid: o.paid,
      amount_due: o.paid ? minus(t.total, o.paid) : t.total,
    },
    lines: lines.map(({ description, item_code, quantity, unit, unit_price, tax_rate, amount }) => ({
      description,
      item_code,
      quantity,
      unit,
      unit_price,
      tax_rate,
      amount,
    })),
    extra: { rate: o.rate },
  }
}

const HARROWGATE = { name: 'Harrowgate Robotics Ltd', address: '9 Gearwheel Park, Coilbridge CB7 2RQ, Examplia' }
const MUEHLBACH = { name: 'Mühlbach Werkzeughandel GmbH', address: 'Ambossweg 14, 34567 Hammerfeld, Examplien' }
const BRUECKNER = { name: 'Brückner & Söhne Metallbau KG', address: 'Funkenstraße 3, 76543 Glutstadt, Examplien' }
const CINDERPINE = { name: 'Cinderpine Brewing Collective', address: '77 Hopvine Street, Barleyport, EX 00981, Examplia' }
const VERLAINE = { name: 'Atelier Verlaine Graphisme SARL', address: '8 rue des Encriers, 45678 Plumeville, Exemplie' }
const HERON = { name: 'Librairie du Héron Bleu', address: '31 quai des Lanternes, 23456 Roseval, Exemplie' }
const OLD_FERRY = { name: 'Old Ferry Guesthouse', address: 'The Slipway, Gullhaven GH2 1PJ, Examplia' }
const FERROCLINE = { name: 'Ferrocline Components Ltd', address: '60 Rivet Row, Boltham BH4 9DD, Examplia' }
const JUNIPER = { name: 'Juniper Steel Fabrication', address: '3 Anvil Court, Ironwood Flats, EX 00512, Examplia' }
const ALPENBLICK = { name: 'Alpenblick Hotel AG', address: 'Gipfelweg 2, 3999 Wolkenried, Examplien' }
const MARROWFIELD = { name: 'Marrowfield Garden Centre Ltd', address: '1 Seedling Way, Furrowby FB8 3AA, Examplia' }
const COYOTE = { name: 'Coyote Ridge Landscaping LLC', address: '900 Mesa Verde Drive, Sagebrush Flats, EX 00288, Examplia' }
const LARKSPUR = { name: 'Larkspur Dental Practice', address: '12 Primrose Parade, Kingsmere KM1 6QD, Examplia' }
const HARROWGATE_BAY = 'Bay 4, 9 Gearwheel Park, Coilbridge CB7 2RQ, Examplia'

const LAB_ITEMS: Priced[] = [
  item('BLP-1001', 'Nitrile gloves, size M (100)', '10', 'box', '9.80'),
  item('BLP-1002', 'Nitrile gloves, size L (100)', '10', 'box', '9.80'),
  item('BLP-1110', 'pH test strips, 0-14 (100)', '6', 'pack', '7.45'),
  item('BLP-1204', 'Glass beaker, 250 ml', '12', 'pcs', '4.60'),
  item('BLP-1205', 'Glass beaker, 1000 ml', '6', 'pcs', '9.25'),
  item('BLP-1310', 'Graduated cylinder, 100 ml', '4', 'pcs', '11.90'),
  item('BLP-1402', 'Hydrometer, 1.000-1.100', '3', 'pcs', '18.50'),
  item('BLP-1415', 'Refractometer, Brix 0-32', '1', 'pcs', '64.00'),
  item('BLP-1520', 'Sanitiser concentrate, 5 L', '4', 'can', '27.30'),
  item('BLP-1522', 'Spray bottle, 1 L', '8', 'pcs', '3.15'),
  item('BLP-1601', 'Sample vials, 50 ml (24)', '5', 'pack', '12.40'),
  item('BLP-1602', 'Vial labels, waterproof (500)', '2', 'roll', '8.90'),
  item('BLP-1710', 'Digital thermometer probe', '3', 'pcs', '22.75'),
  item('BLP-1801', 'Pipette tips, 1 ml (1000)', '2', 'box', '15.60'),
  item('BLP-1802', 'Micropipette, 100-1000 ul', '1', 'pcs', '129.00'),
  item('BLP-1905', 'Petri dishes, 90 mm (500)', '1', 'case', '58.20'),
  item('BLP-2001', 'Yeast nutrient, 500 g', '4', 'tub', '13.80'),
  item('BLP-2010', 'Lab notebook, A4, grid', '6', 'pcs', '5.40'),
  item('BLP-2104', 'Wash bottle, 500 ml', '6', 'pcs', '4.95'),
  item('BLP-2203', 'Funnel set, polypropylene', '2', 'set', '9.60'),
  item('BLP-2301', 'Safety goggles, anti-fog', '8', 'pcs', '6.70'),
  item('BLP-2402', 'Lab coat, white, size L', '4', 'pcs', '24.50'),
  item('BLP-2510', 'Magnetic stir bar set', '1', 'set', '19.90'),
  item('BLP-2511', 'Magnetic stirrer, 5 L', '1', 'pcs', '142.00'),
  item('BLP-2602', 'Tubing, silicone, 10 m', '2', 'roll', '31.20'),
  item('BLP-2703', 'Hose clamps, stainless (20)', '3', 'pack', '8.35'),
  item('BLP-2804', 'Cleaning brushes, assorted', '2', 'set', '11.10'),
  item('BLP-2905', 'Storage rack, 4 tiers', '1', 'pcs', '86.00'),
]

export const INVOICES: EvalDocument[] = [
  invoice({
    file: 'invoice-01.pdf',
    note: 'Office supplies: logo left, details right, a VAT column on every line, long English dates; the customer prints no tax id.',
    style: { lang: 'en', date: 'long-en', number: 'en', layout: 1, currency: 'before' },
    currency: 'EUR',
    printed: 'EUR',
    parties: {
      vendor_name: 'Thistledown Office Supply Co.',
      vendor_address: '22 Quarry Mews, Ashbourne Vale AV3 8LT, Examplia',
      vendor_tax_id: 'EX204118377',
      customer_name: HARROWGATE.name,
      customer_address: HARROWGATE.address,
      customer_tax_id: '',
    },
    meta: { invoice_number: 'TOS-24-01187', purchase_order_number: 'HR-PO-5521', payment_terms: 'Net 30', invoice_date: '2026-09-03', due_date: '2026-10-03' },
    lines: [
      item('TOS-P-201', 'Laser printer toner, black', '3', 'pcs', '64.90'),
      item('TOS-S-118', 'Archive boxes, pack of 10', '6', 'pack', '14.25'),
      item('TOS-D-044', 'Ergonomic footrest', '2', 'pcs', '39.00'),
      item('TOS-C-310', 'Whiteboard markers, assorted (12)', '5', 'set', '8.40'),
    ],
    lineRate: '19',
    rate: '19',
    discount: '0.00',
    shipping: '12.00',
    paid: '',
  }),
  invoice({
    file: 'invoice-02.pdf',
    note: 'German tool dealer: coloured band, amounts as 1.234,56 €, a decimal quantity, a discount and a deposit already paid.',
    style: { lang: 'de', date: 'dmy.', number: 'eu', layout: 2, currency: 'after' },
    currency: 'EUR',
    printed: '€',
    parties: {
      vendor_name: MUEHLBACH.name,
      vendor_address: MUEHLBACH.address,
      vendor_tax_id: 'EX318552904',
      customer_name: BRUECKNER.name,
      customer_address: BRUECKNER.address,
      customer_tax_id: 'EX771204335',
    },
    meta: {
      invoice_number: 'RE-2026-0917',
      purchase_order_number: 'B-44812',
      payment_terms: 'Zahlbar innerhalb von 14 Tagen',
      invoice_date: '2026-09-17',
      due_date: '2026-10-01',
    },
    lines: [
      item('MW-1042', 'Akku-Bohrschrauber 18 V', '2', 'Stk', '129.00'),
      item('MW-2210', 'Bohrersatz HSS, 19-teilig', '4', 'Satz', '23.50'),
      item('MW-3307', 'Schutzbrille, klar', '12', 'Stk', '4.80'),
      item('MW-0815', 'Werkbankauflage, Gummi', '2.5', 'm', '18.60'),
      item('MW-5120', 'Arbeitshandschuhe, Gr. 10', '10', 'Paar', '3.95'),
    ],
    lineRate: '19',
    rate: '19',
    discount: '25.00',
    shipping: '0.00',
    paid: '200.00',
  }),
  invoice({
    file: 'invoice-03.pdf',
    note: 'US lab supplier on Letter paper: 28 lines over two pages, no tax column, sales tax 8.25%, no PO number.',
    style: { lang: 'en', date: 'long-us', number: 'en', layout: 3, currency: 'before' },
    currency: 'USD',
    printed: 'USD',
    parties: {
      vendor_name: 'Bluegill Lab Provisions Inc.',
      vendor_address: '1400 Mockingbird Loop, Fairhaven Bluffs, EX 00412, Examplia',
      vendor_tax_id: 'EX-58-2201947',
      customer_name: CINDERPINE.name,
      customer_address: CINDERPINE.address,
      customer_tax_id: '',
    },
    meta: { invoice_number: 'BLP-008812', purchase_order_number: '', payment_terms: 'Net 45', invoice_date: '2026-10-06', due_date: '2026-11-20' },
    lines: LAB_ITEMS,
    lineRate: '',
    rate: '8.25',
    discount: '0.00',
    shipping: '45.00',
    paid: '',
  }),
  invoice({
    file: 'invoice-04.pdf',
    note: 'French design studio in a typewriter face: amounts as 1 234,56 €, TVA 20 %, lines without item codes.',
    style: { lang: 'fr', date: 'dmy/', number: 'fr', layout: 4, currency: 'after' },
    currency: 'EUR',
    printed: '€',
    parties: {
      vendor_name: VERLAINE.name,
      vendor_address: VERLAINE.address,
      vendor_tax_id: 'EX47812309551',
      customer_name: HERON.name,
      customer_address: HERON.address,
      customer_tax_id: 'EX90334118207',
    },
    meta: { invoice_number: 'F-2026-0342', purchase_order_number: 'BC-1187', payment_terms: 'Paiement à 30 jours', invoice_date: '2026-09-25', due_date: '2026-10-25' },
    lines: [
      item('', 'Création de logo et charte graphique', '1', 'forfait', '850.00'),
      item('', 'Affiches A2, impression quadrichromie', '150', 'ex.', '2.40'),
      item('', 'Marque-pages illustrés', '500', 'ex.', '0.35'),
    ],
    lineRate: '20',
    rate: '20',
    discount: '50.00',
    shipping: '18.00',
    paid: '',
  }),
  invoice({
    file: 'invoice-05.pdf',
    note: 'British web studio with a sidebar, in a serif face: hours as units, a payment on account, no due date or PO.',
    style: { lang: 'en', date: 'dmy/', number: 'en', layout: 5, currency: 'before' },
    currency: 'GBP',
    printed: '£',
    parties: {
      vendor_name: 'Pennywhistle Web Studio Ltd',
      vendor_address: '5 Lantern Court, Mistlecombe MC9 4XE, Examplia',
      vendor_tax_id: 'EX912447108',
      customer_name: OLD_FERRY.name,
      customer_address: OLD_FERRY.address,
      customer_tax_id: '',
    },
    meta: { invoice_number: 'PWS-1093', purchase_order_number: '', payment_terms: 'Due on receipt', invoice_date: '2026-10-12', due_date: '' },
    lines: [
      item('DEV', 'Website redesign, development', '18', 'h', '55.00'),
      item('DES', 'Design workshop', '6', 'h', '60.00'),
      item('HOST', 'Hosting, 12 months', '1', 'yr', '96.00'),
      item('SEO', 'Search listing set-up', '1', 'pcs', '120.00'),
    ],
    lineRate: '',
    rate: '20',
    discount: '0.00',
    shipping: '0.00',
    paid: '150.00',
  }),
]

// Receipts ---------------------------------------------------------------------------------------

type Bought = { description: string; quantity: string; unit_price: string }
const bought = (description: string, quantity: string, unit_price: string): Bought => ({ description, quantity, unit_price })

function receipt(o: {
  file: string
  note: string
  style: PrintStyle
  currency: string
  printed: string
  merchant: Record<string, string>
  meta: Record<string, string>
  lines: Bought[]
  rate: string
  tip: string
}): EvalDocument {
  const lines = o.lines.map((l) => ({ ...l, amount: times(l.quantity, l.unit_price) }))
  const subtotal = plus(...lines.map((l) => l.amount))
  const tax_total = percentOf(subtotal, o.rate)
  return {
    file: o.file,
    docType: 'receipt',
    note: o.note,
    style: o.style,
    fields: {
      ...LANGUAGE(o.style.lang),
      currency: o.currency,
      currency_as_printed: o.printed,
      ...o.merchant,
      ...o.meta,
      subtotal,
      tax_total,
      tip: o.tip,
      total: plus(subtotal, tax_total, o.tip),
    },
    lines,
    extra: { rate: o.rate },
  }
}

export const RECEIPTS: EvalDocument[] = [
  receipt({
    file: 'receipt-01.png',
    note: 'A café till receipt, photographed on a table with a slight tilt; card payment and a tip.',
    style: { lang: 'en', date: 'dmy.', number: 'plain', layout: 1, currency: 'none' },
    currency: 'EUR',
    printed: 'EUR',
    merchant: { merchant_name: 'WREN AND KETTLE CAFE', merchant_address: '3 MARKET STEPS, DUNMORROW, EXAMPLIA', merchant_tax_id: 'EX 448 2210 19' },
    meta: { receipt_number: '102394', payment_method: 'VISA', card_last4: '6630', transaction_date: '2026-10-02', transaction_time: '08:41' },
    lines: [bought('LATTE', '2', '3.20'), bought('CROISSANT', '2', '2.60'), bought('ORANGE JUICE', '1', '3.50')],
    rate: '10',
    tip: '1.00',
  }),
  receipt({
    file: 'receipt-02.png',
    note: 'A German bakery receipt, photographed under warm light: comma decimals, paid in cash, so no card number.',
    style: { lang: 'de', date: 'dmy.', number: 'eu', layout: 2, currency: 'none' },
    currency: 'EUR',
    printed: 'EUR',
    merchant: { merchant_name: 'BAECKEREI KORNBLUME', merchant_address: 'LINDENPLATZ 7, 12345 MEHLINGEN', merchant_tax_id: 'EX 271 093 554' },
    meta: { receipt_number: '0583', payment_method: 'BAR', card_last4: '', transaction_date: '2026-10-10', transaction_time: '07:15' },
    lines: [bought('ROGGENBROT', '1', '3.90'), bought('BREZEL', '4', '0.85'), bought('KAFFEE', '2', '2.40'), bought('APFELTASCHE', '1', '2.10')],
    rate: '7',
    tip: '0.00',
  }),
  receipt({
    file: 'receipt-03.png',
    note: 'A pub bill on a wide till roll, photographed at an angle in dim light; pounds, a tip and a Mastercard.',
    style: { lang: 'en', date: 'dmy/', number: 'plain', layout: 3, currency: 'none' },
    currency: 'GBP',
    printed: 'GBP',
    merchant: { merchant_name: 'THE DROWSY OTTER', merchant_address: '41 TOWPATH ROW, REEDMOOR RM5 6AB, EXAMPLIA', merchant_tax_id: 'EX 330 1958 42' },
    meta: { receipt_number: '7781', payment_method: 'MASTERCARD', card_last4: '2207', transaction_date: '2026-10-17', transaction_time: '21:09' },
    lines: [bought('FISH PIE', '2', '13.50'), bought('GARDEN SALAD', '1', '8.75'), bought('PALE ALE PINT', '3', '5.20'), bought('STICKY TOFFEE PUD', '2', '6.25')],
    rate: '20',
    tip: '6.00',
  }),
  receipt({
    file: 'receipt-04.pdf',
    note: 'A French taxi receipt as a narrow PDF: long French date, amounts as 38,00 €, a tip.',
    style: { lang: 'fr', date: 'long-fr', number: 'fr', layout: 4, currency: 'after' },
    currency: 'EUR',
    printed: '€',
    merchant: { merchant_name: 'Taxis Mouette Bleue', merchant_address: '12 avenue des Goélands, 34567 Portvent, Exemplie', merchant_tax_id: 'EX52774019336' },
    meta: { receipt_number: '88412', payment_method: 'Carte bancaire', card_last4: '7314', transaction_date: '2026-10-21', transaction_time: '06:05' },
    lines: [bought('Course Gare Centrale - Aéroport', '1', '38.00'), bought('Supplément bagage', '2', '1.50')],
    rate: '10',
    tip: '2.00',
  }),
  receipt({
    file: 'receipt-05.pdf',
    note: 'A US restaurant pickup e-receipt: month-first date, sales tax 6.5%, Amex; the merchant prints no tax id.',
    style: { lang: 'en', date: 'mdy/', number: 'en', layout: 5, currency: 'before' },
    currency: 'USD',
    printed: 'USD',
    merchant: { merchant_name: 'Saffron Lane Kitchen', merchant_address: '208 Juniper Avenue, Wexford Hollow, EX 00733, Examplia', merchant_tax_id: '' },
    meta: { receipt_number: 'SLK-55019', payment_method: 'Amex', card_last4: '1005', transaction_date: '2026-10-24', transaction_time: '19:42' },
    lines: [bought('Chicken tikka bowl', '2', '13.95'), bought('Garlic naan', '3', '3.25'), bought('Mango lassi', '2', '4.50')],
    rate: '6.5',
    tip: '5.00',
  }),
]

// Bank statements --------------------------------------------------------------------------------

type Tx = [date: string, description: string, reference: string, amount: string]

/**
 * The transactions with their running balances: on every line, on none, or only on a day's last
 * transaction; and the closing balance and the totals in and out.
 */
function statement(opening: string, txs: Tx[], balances: 'every' | 'none' | 'daily') {
  let running = opening
  const lines = txs.map(([date, description, reference, amount], i) => {
    running = plus(running, amount)
    const lastOfDay = txs[i + 1]?.[0] !== date
    const balance = balances === 'every' || (balances === 'daily' && lastOfDay) ? running : ''
    return { date, description, reference, amount, balance }
  })
  const credits = plus(...txs.map(([, , , a]) => (a.startsWith('-') ? '0' : a)))
  const debits = plus(...txs.map(([, , , a]) => (a.startsWith('-') ? a.slice(1) : '0')))
  return { lines, closing: running, credits, debits }
}

function bankStatement(o: {
  file: string
  note: string
  style: PrintStyle
  currency: string
  printed: string
  bank: string
  holder: string
  accountNumber: string
  iban: string
  period: [string, string]
  opening: string
  txs: Tx[]
  balances: 'every' | 'none' | 'daily'
  printsTotals: boolean
  extra: Record<string, string>
}): EvalDocument {
  const s = statement(o.opening, o.txs, o.balances)
  const last4 = (v: string) => v.replace(/\s/g, '').slice(-4)
  return {
    file: o.file,
    docType: 'bank_statement',
    note: o.note,
    style: o.style,
    fields: {
      ...LANGUAGE(o.style.lang),
      currency: o.currency,
      currency_as_printed: o.printed,
      bank_name: o.bank,
      account_holder: o.holder,
      account_number_last4: last4(o.accountNumber),
      iban_last4: o.iban ? last4(o.iban) : '',
      statement_period_start: o.period[0],
      statement_period_end: o.period[1],
      opening_balance: o.opening,
      closing_balance: s.closing,
      total_credits: o.printsTotals ? s.credits : '',
      total_debits: o.printsTotals ? s.debits : '',
    },
    lines: s.lines,
    extra: { ...o.extra, accountNumber: o.accountNumber, iban: o.iban },
  }
}

export const BANK_STATEMENTS: EvalDocument[] = [
  bankStatement({
    file: 'bank-statement-01.pdf',
    note: 'A garden centre’s month over two pages: signed amounts and a balance on every line, ISO dates.',
    style: { lang: 'en', date: 'iso', number: 'en', layout: 1, currency: 'none' },
    currency: 'EUR',
    printed: 'EUR',
    bank: 'Tidewater Cooperative Bank',
    holder: MARROWFIELD.name,
    accountNumber: '4402 7781 3390',
    iban: 'EX47 TWCB 4402 7781 3390 15',
    period: ['2026-09-01', '2026-09-30'],
    opening: '5120.40',
    balances: 'every',
    printsTotals: true,
    extra: { bankAddress: '2 Harbourmaster Way, Saltlick Bay SB1 1TW, Examplia', holderAddress: MARROWFIELD.address },
    txs: [
      ['2026-09-01', 'Card sales settlement', 'SET-0901', '1284.60'],
      ['2026-09-01', 'Rent Furrowby Estates', 'RENT-09', '-1850.00'],
      ['2026-09-02', 'Supplier Greenvale Nurseries', 'GVN-4471', '-742.15'],
      ['2026-09-03', 'Card sales settlement', 'SET-0903', '936.25'],
      ['2026-09-04', 'Direct debit Furrowby Water', 'DD-FW-221', '-88.40'],
      ['2026-09-05', 'Card sales settlement', 'SET-0905', '1502.80'],
      ['2026-09-07', 'Payroll week 36', 'PAY-W36', '-2210.00'],
      ['2026-09-08', 'Supplier Peatless Compost Co', 'PCC-0912', '-416.00'],
      ['2026-09-09', 'Card sales settlement', 'SET-0909', '874.10'],
      ['2026-09-10', 'Insurance Bramblegate Mutual', 'INS-BM-09', '-133.75'],
      ['2026-09-12', 'Card sales settlement', 'SET-0912', '1690.45'],
      ['2026-09-14', 'Payroll week 38', 'PAY-W38', '-2210.00'],
      ['2026-09-15', 'Supplier Greenvale Nurseries', 'GVN-4502', '-1105.30'],
      ['2026-09-16', 'Card sales settlement', 'SET-0916', '958.90'],
      ['2026-09-18', 'Electricity Furrowby Power', 'DD-FP-0918', '-264.20'],
      ['2026-09-19', 'Card sales settlement', 'SET-0919', '2045.35'],
      ['2026-09-21', 'Payroll week 39', 'PAY-W39', '-2210.00'],
      ['2026-09-23', 'Card sales settlement', 'SET-0923', '1122.70'],
      ['2026-09-25', 'Delivery van lease', 'LEASE-09', '-389.00'],
      ['2026-09-26', 'Card sales settlement', 'SET-0926', '1876.15'],
      ['2026-09-28', 'Payroll week 40', 'PAY-W40', '-2210.00'],
      ['2026-09-30', 'Account fee', 'FEE-09', '-12.50'],
    ],
  }),
  bankStatement({
    file: 'bank-statement-02.pdf',
    note: 'A British building society statement: money in and money out in separate columns, pounds, day-first dates.',
    style: { lang: 'en', date: 'dmy/', number: 'en', layout: 2, currency: 'none' },
    currency: 'GBP',
    printed: 'GBP',
    bank: 'Kingsmere Building Society',
    holder: LARKSPUR.name,
    accountNumber: '20-44-91 61530719',
    iban: 'EX29 KMBS 2044 9161 5307 19',
    period: ['2026-09-01', '2026-09-30'],
    opening: '8412.07',
    balances: 'every',
    printsTotals: true,
    extra: { bankAddress: 'Society House, 1 Guild Street, Kingsmere KM1 1AA, Examplia', holderAddress: LARKSPUR.address },
    txs: [
      ['2026-09-01', 'Patient payments, card', 'BATCH 0901', '1840.00'],
      ['2026-09-02', 'Dental supplies, Pearlwhite Ltd', 'PW-55120', '-612.48'],
      ['2026-09-05', 'Rent, Primrose Parade', 'SO RENT', '-1500.00'],
      ['2026-09-08', 'Patient payments, card', 'BATCH 0908', '2215.50'],
      ['2026-09-12', 'Lab work, Ivorycrest Lab', 'ICL-2209', '-845.00'],
      ['2026-09-15', 'Salaries', 'BACS SAL', '-4120.00'],
      ['2026-09-19', 'Patient payments, card', 'BATCH 0919', '1977.25'],
      ['2026-09-22', 'Waste collection, Medisweep', 'DD MSW', '-74.90'],
      ['2026-09-26', 'Patient payments, card', 'BATCH 0926', '1630.00'],
      ['2026-09-30', 'Interest', 'INT', '3.12'],
    ],
  }),
  bankStatement({
    file: 'bank-statement-03.pdf',
    note: 'A German statement: signed amounts as -1.234,56, no running balance column and no totals in or out.',
    style: { lang: 'de', date: 'dmy.', number: 'eu', layout: 3, currency: 'none' },
    currency: 'EUR',
    printed: 'EUR',
    bank: 'Bank Nebelsee eG',
    holder: 'Fischer Gartenbau GmbH',
    accountNumber: '7040 1188 26',
    iban: 'EX12 5009 7040 1188 26',
    period: ['2026-09-01', '2026-09-30'],
    opening: '3207.55',
    balances: 'none',
    printsTotals: false,
    extra: { bankAddress: 'Uferstraße 1, 98765 Nebelsee, Examplien', holderAddress: 'Gärtnerweg 12, 98766 Grünau, Examplien' },
    txs: [
      ['2026-09-01', 'Miete Gewächshaus', 'MIETE 09/2026', '-950.00'],
      ['2026-09-03', 'Überweisung Blumenhaus Rosenrot', 'RE 2026-311', '1280.00'],
      ['2026-09-04', 'Lastschrift Stadtwerke Grünau', 'STROM 09', '-214.36'],
      ['2026-09-08', 'Kartenzahlung Baumarkt Hobelspan', 'KA 0908', '-87.90'],
      ['2026-09-10', 'Überweisung Friedhofsgärtnerei Linde', 'RE 2026-315', '640.50'],
      ['2026-09-12', 'Lohn August', 'LOHN 08', '-2380.00'],
      ['2026-09-15', 'Überweisung Hotel Seeblick', 'RE 2026-318', '1955.00'],
      ['2026-09-18', 'Lastschrift Versicherung Eichenhof', 'VERS 2026', '-312.40'],
      ['2026-09-22', 'Kartenzahlung Tankstelle Am Ring', 'KA 0922', '-74.15'],
      ['2026-09-25', 'Überweisung Gemeinde Grünau', 'RE 2026-322', '2310.00'],
      ['2026-09-28', 'Saatgut Feldmann', 'RE SF-881', '-428.60'],
      ['2026-09-30', 'Kontoführung', 'ENTGELT 09', '-9.90'],
    ],
  }),
  bankStatement({
    file: 'bank-statement-04.pdf',
    note: 'A French bakery’s August over three pages: débit and crédit columns, amounts as 1 234,56, a balance on every line.',
    style: { lang: 'fr', date: 'dmy/', number: 'fr', layout: 4, currency: 'none' },
    currency: 'EUR',
    printed: 'EUR',
    bank: 'Banque Coopérative du Littoral',
    holder: 'Boulangerie Les Trois Épis',
    accountNumber: '00042 99817 63',
    iban: 'EX76 1009 6000 4299 8176 333',
    period: ['2026-08-01', '2026-08-31'],
    opening: '6815.22',
    balances: 'every',
    printsTotals: true,
    extra: { bankAddress: '5 place du Phare, 56789 Brisemer, Exemplie', holderAddress: '18 rue du Four, 56790 Blé-sur-Mer, Exemplie' },
    txs: [
      ['2026-08-01', 'Remise carte bancaire', 'RCB 0108', '1120.40'],
      ['2026-08-01', 'Loyer local commercial', 'LOYER 08', '-1400.00'],
      ['2026-08-02', 'Remise carte bancaire', 'RCB 0208', '985.10'],
      ['2026-08-03', 'Remise espèces', 'ESP 0308', '640.00'],
      ['2026-08-04', 'Prélèvement Minoterie du Moulin', 'MIN 4471', '-1236.80'],
      ['2026-08-05', 'Remise carte bancaire', 'RCB 0508', '874.25'],
      ['2026-08-06', 'Prélèvement Électricité Littorale', 'ELEC 08', '-412.60'],
      ['2026-08-07', 'Remise carte bancaire', 'RCB 0708', '1032.75'],
      ['2026-08-08', 'Achat Crèmerie Lactalune', 'CRL 0808', '-318.45'],
      ['2026-08-09', 'Remise carte bancaire', 'RCB 0908', '1210.90'],
      ['2026-08-10', 'Remise espèces', 'ESP 1008', '715.00'],
      ['2026-08-11', 'Prélèvement Assurance Phare', 'ASS 08', '-96.30'],
      ['2026-08-12', 'Remise carte bancaire', 'RCB 1208', '902.35'],
      ['2026-08-13', 'Salaires juillet', 'SAL 07', '-4820.00'],
      ['2026-08-14', 'Remise carte bancaire', 'RCB 1408', '1144.60'],
      ['2026-08-15', 'Remise carte bancaire', 'RCB 1508', '1388.20'],
      ['2026-08-16', 'Remise espèces', 'ESP 1608', '590.00'],
      ['2026-08-17', 'Achat Emballages Kraftine', 'EMB 1708', '-264.90'],
      ['2026-08-18', 'Remise carte bancaire', 'RCB 1808', '956.45'],
      ['2026-08-19', 'Prélèvement Eau de Brisemer', 'EAU 08', '-58.70'],
      ['2026-08-20', 'Remise carte bancaire', 'RCB 2008', '1018.30'],
      ['2026-08-21', 'Prélèvement Minoterie du Moulin', 'MIN 4502', '-1189.40'],
      ['2026-08-22', 'Remise carte bancaire', 'RCB 2208', '1265.85'],
      ['2026-08-23', 'Remise espèces', 'ESP 2308', '682.00'],
      ['2026-08-24', 'Achat Crèmerie Lactalune', 'CRL 2408', '-342.15'],
      ['2026-08-25', 'Remise carte bancaire', 'RCB 2508', '890.60'],
      ['2026-08-26', 'Entretien four, Fourneaux Dorés', 'FD 2608', '-385.00'],
      ['2026-08-27', 'Remise carte bancaire', 'RCB 2708', '1097.15'],
      ['2026-08-28', 'Remboursement prêt matériel', 'PRET 08', '-650.00'],
      ['2026-08-29', 'Remise carte bancaire', 'RCB 2908', '1302.40'],
      ['2026-08-30', 'Remise espèces', 'ESP 3008', '705.00'],
      ['2026-08-30', 'Achat Farines du Val', 'FDV 3008', '-574.25'],
      ['2026-08-31', 'Remise carte bancaire', 'RCB 3108', '1176.90'],
      ['2026-08-31', 'Cotisation carte professionnelle', 'COT 08', '-14.50'],
      ['2026-08-31', 'Frais de tenue de compte', 'FRAIS 08', '-21.00'],
    ],
  }),
  bankStatement({
    file: 'bank-statement-05.pdf',
    note: 'A US savings and loan statement: month-first dates, a balance only after each day’s last transaction, no IBAN.',
    style: { lang: 'en', date: 'mdy/', number: 'en', layout: 5, currency: 'none' },
    currency: 'USD',
    printed: 'USD',
    bank: 'Prairie Lantern Savings & Loan',
    holder: COYOTE.name,
    accountNumber: '3307-118-2245',
    iban: '',
    period: ['2026-09-16', '2026-10-15'],
    opening: '12480.33',
    balances: 'daily',
    printsTotals: true,
    extra: { bankAddress: '400 Grain Elevator Road, Tallgrass, EX 00104, Examplia', holderAddress: COYOTE.address },
    txs: [
      ['2026-09-16', 'Deposit, Mesa Verde HOA', 'CHK 1182', '3400.00'],
      ['2026-09-16', 'Sagebrush Nursery supply', 'ACH 55120', '-1286.45'],
      ['2026-09-18', 'Fuel, Red Butte Gas', 'POS 0918', '-212.80'],
      ['2026-09-22', 'Payroll', 'ACH PAYRL', '-5640.00'],
      ['2026-09-24', 'Deposit, Juniper Hills Golf Club', 'CHK 1190', '4875.00'],
      ['2026-09-24', 'Equipment rental, Dustdevil Rentals', 'ACH 55188', '-690.00'],
      ['2026-09-29', 'Truck loan payment', 'ACH LOAN', '-842.17'],
      ['2026-10-01', 'Deposit, City of Sagebrush Flats', 'ACH CITY', '6220.00'],
      ['2026-10-01', 'Office rent', 'ACH RENT', '-1350.00'],
      ['2026-10-06', 'Payroll', 'ACH PAYRL', '-5640.00'],
      ['2026-10-08', 'Irrigation parts, Canyon Drip Supply', 'POS 1008', '-388.62'],
      ['2026-10-12', 'Deposit, Coyote Ridge HOA', 'CHK 1201', '2950.00'],
      ['2026-10-14', 'Insurance, Tumbleweed Mutual', 'ACH INS', '-475.25'],
      ['2026-10-15', 'Service charge', 'FEE', '-15.00'],
    ],
  }),
]

// Purchase orders --------------------------------------------------------------------------------

function purchaseOrder(o: {
  file: string
  note: string
  style: PrintStyle
  currency: string
  printed: string
  parties: Record<string, string>
  meta: Record<string, string>
  lines: Priced[]
  rate: string
  shipping: string
}): EvalDocument {
  const lines = withAmounts(o.lines)
  const t = totals(lines, o.rate, '0.00', o.shipping)
  return {
    file: o.file,
    docType: 'purchase_order',
    note: o.note,
    style: o.style,
    fields: {
      ...LANGUAGE(o.style.lang),
      currency: o.currency,
      currency_as_printed: o.printed,
      ...o.parties,
      ...o.meta,
      subtotal: t.subtotal,
      tax_total: t.tax_total,
      shipping: t.shipping,
      total: t.total,
    },
    lines: lines.map(({ item_code, description, quantity, unit, unit_price, amount }) => ({ item_code, description, quantity, unit, unit_price, amount })),
    extra: { rate: o.rate },
  }
}

export const PURCHASE_ORDERS: EvalDocument[] = [
  purchaseOrder({
    file: 'purchase-order-01.pdf',
    note: 'A robotics firm’s order for parts: logo left, ISO dates, delivery to a different bay, no requested delivery date.',
    style: { lang: 'en', date: 'iso', number: 'en', layout: 1, currency: 'before' },
    currency: 'EUR',
    printed: 'EUR',
    parties: {
      buyer_name: HARROWGATE.name,
      buyer_address: HARROWGATE.address,
      supplier_name: FERROCLINE.name,
      supplier_address: FERROCLINE.address,
      ship_to_address: HARROWGATE_BAY,
    },
    meta: { po_number: 'HR-PO-5540', payment_terms: 'Net 30', order_date: '2026-09-08', requested_delivery_date: '' },
    lines: [
      item('FC-SRV-12', 'Servo motor, 12 V', '8', 'pcs', '46.50'),
      item('FC-BRK-03', 'Mounting bracket, steel', '16', 'pcs', '3.75'),
      item('FC-CBL-50', 'Signal cable, 50 cm', '40', 'pcs', '1.20'),
    ],
    rate: '19',
    shipping: '15.00',
  }),
  purchaseOrder({
    file: 'purchase-order-02.pdf',
    note: 'A Dutch nursery’s order: coloured band, dates as 22-09-2026, amounts as € 1.234,56, BTW 21%.',
    style: { lang: 'nl', date: 'dmy-', number: 'eu', layout: 2, currency: 'before' },
    currency: 'EUR',
    printed: '€',
    parties: {
      buyer_name: 'Tulpenhof Bloemenkwekerij B.V.',
      buyer_address: 'Kasweg 21, 1234 AB Bloemdijk, Exemplië',
      supplier_name: 'Glaswerk Van Duinen',
      supplier_address: 'Zandpad 5, 5678 CD Strandveen, Exemplië',
      ship_to_address: 'Kas 3, Kasweg 23, 1234 AB Bloemdijk, Exemplië',
    },
    meta: { po_number: 'TH-2026-118', payment_terms: 'Betaling binnen 30 dagen', order_date: '2026-09-22', requested_delivery_date: '2026-10-13' },
    lines: [
      item('GV-K120', 'Kweekbak, 120 x 60 cm', '12', 'stuks', '24.90'),
      item('GV-S05', 'Sproeikop, messing', '30', 'stuks', '3.15'),
      item('GV-T25', 'Tuinslang, 25 m', '4', 'rol', '32.00'),
    ],
    rate: '21',
    shipping: '19.50',
  }),
  purchaseOrder({
    file: 'purchase-order-03.pdf',
    note: 'A US brewery’s order for steel vessels on Letter paper: centred letterhead, long US dates, sales tax 7%.',
    style: { lang: 'en', date: 'long-us', number: 'en', layout: 3, currency: 'before' },
    currency: 'USD',
    printed: 'USD',
    parties: {
      buyer_name: CINDERPINE.name,
      buyer_address: CINDERPINE.address,
      supplier_name: JUNIPER.name,
      supplier_address: JUNIPER.address,
      ship_to_address: 'Warehouse B, 81 Hopvine Street, Barleyport, EX 00981, Examplia',
    },
    meta: { po_number: '2026-0457', payment_terms: 'Net 30', order_date: '2026-10-01', requested_delivery_date: '2026-10-29' },
    lines: [
      item('JSF-FV-500', 'Fermentation vessel, 500 L', '2', 'ea', '2850.00'),
      item('JSF-VL-02', 'Sanitary valve, 2 in', '6', 'ea', '118.40'),
      item('JSF-CL-15', 'Tri-clamp, 1.5 in', '24', 'ea', '6.85'),
    ],
    rate: '7',
    shipping: '380.00',
  }),
  purchaseOrder({
    file: 'purchase-order-04.pdf',
    note: 'A hotel’s order for linen in a typewriter face: Swiss francs as CHF 1’234.50, MWST 8.1%, shipping 0.00.',
    style: { lang: 'de', date: 'dmy.', number: 'ch', layout: 4, currency: 'before' },
    currency: 'CHF',
    printed: 'CHF',
    parties: {
      buyer_name: ALPENBLICK.name,
      buyer_address: ALPENBLICK.address,
      supplier_name: 'Seidenfaden Textil AG',
      supplier_address: 'Spindelgasse 11, 8888 Garnhausen, Examplien',
      ship_to_address: 'Wäscherei, Talstrasse 40, 3999 Wolkenried, Examplien',
    },
    meta: { po_number: 'AB-7731', payment_terms: '30 Tage netto', order_date: '2026-10-05', requested_delivery_date: '2026-10-26' },
    lines: [
      item('ST-BL-200', 'Bettlaken 160 x 200 cm', '40', 'Stk', '34.90'),
      item('ST-HT-50', 'Handtuch 50 x 100 cm', '80', 'Stk', '12.40'),
      item('ST-BM-01', 'Bademantel, Gr. L', '15', 'Stk', '59.00'),
    ],
    rate: '8.1',
    shipping: '0.00',
  }),
  purchaseOrder({
    file: 'purchase-order-05.pdf',
    note: 'A Spanish olive farm’s order for bottles: sidebar, serif face, long Spanish dates, amounts as 1.234,56 €.',
    style: { lang: 'es', date: 'long-es', number: 'eu', layout: 5, currency: 'after' },
    currency: 'EUR',
    printed: '€',
    parties: {
      buyer_name: 'Olivar de la Ladera S.L.',
      buyer_address: 'Camino del Molino 9, 23456 Villaserena, Ejemplia',
      supplier_name: 'Envases Brisamar S.A.',
      supplier_address: 'Polígono Las Gaviotas 14, 34567 Puertoclaro, Ejemplia',
      ship_to_address: 'Camino del Molino 9, 23456 Villaserena, Ejemplia',
    },
    meta: { po_number: 'OL-PC-0092', payment_terms: 'Pago a 60 días', order_date: '2026-09-29', requested_delivery_date: '2026-10-20' },
    lines: [
      item('EB-BV-500', 'Botella de vidrio, 500 ml', '1200', 'ud.', '0.42'),
      item('EB-TP-31', 'Tapón de rosca, 31 mm', '1200', 'ud.', '0.06'),
      item('EB-CJ-12', 'Caja de cartón, 12 botellas', '100', 'ud.', '0.95'),
    ],
    rate: '21',
    shipping: '60.00',
  }),
]

// Delivery notes ---------------------------------------------------------------------------------

type Shipped = { item_code: string; description: string; quantity_ordered: string; quantity_delivered: string; unit: string }
const shipped = (item_code: string, description: string, quantity_ordered: string, quantity_delivered: string, unit: string): Shipped => ({
  item_code,
  description,
  quantity_ordered,
  quantity_delivered,
  unit,
})

function deliveryNote(o: {
  file: string
  note: string
  style: PrintStyle
  /** The currency a note prints beside a goods value, or '' for none (PRD 4.1: it has no amounts). */
  currency: string
  printed: string
  fields: Record<string, string>
  lines: Shipped[]
  printsTotal: boolean
  extra: Record<string, string>
}): EvalDocument {
  const total = o.lines.reduce((t, l) => t + Number(l.quantity_delivered), 0)
  return {
    file: o.file,
    docType: 'delivery_note',
    note: o.note,
    style: o.style,
    fields: {
      ...LANGUAGE(o.style.lang),
      currency: o.currency,
      currency_as_printed: o.printed,
      ...o.fields,
      total_quantity: o.printsTotal ? String(total) : '',
    },
    lines: o.lines,
    extra: o.extra,
  }
}

export const DELIVERY_NOTES: EvalDocument[] = [
  deliveryNote({
    file: 'delivery-note-01.pdf',
    note: 'The parts of purchase order 01, all delivered: logo left, ISO date, carrier and tracking number.',
    style: { lang: 'en', date: 'iso', number: 'en', layout: 1, currency: 'none' },
    currency: '',
    printed: '',
    fields: {
      supplier_name: FERROCLINE.name,
      customer_name: HARROWGATE.name,
      ship_to_address: HARROWGATE_BAY,
      delivery_note_number: 'FC-DN-30981',
      po_number: 'HR-PO-5540',
      carrier: 'Swiftlark Couriers',
      tracking_number: 'SLC-55821-0442',
      delivery_date: '2026-09-14',
      total_packages: '3',
    },
    lines: [
      shipped('FC-SRV-12', 'Servo motor, 12 V', '8', '8', 'pcs'),
      shipped('FC-BRK-03', 'Mounting bracket, steel', '16', '16', 'pcs'),
      shipped('FC-CBL-50', 'Signal cable, 50 cm', '40', '40', 'pcs'),
    ],
    printsTotal: true,
    extra: { supplierAddress: FERROCLINE.address },
  }),
  deliveryNote({
    file: 'delivery-note-02.pdf',
    note: 'A German Lieferschein with a short delivery on two lines and a goods value in EUR, so it prints a currency.',
    style: { lang: 'de', date: 'dmy.', number: 'eu', layout: 2, currency: 'none' },
    currency: 'EUR',
    printed: 'EUR',
    fields: {
      supplier_name: MUEHLBACH.name,
      customer_name: BRUECKNER.name,
      ship_to_address: 'Halle 2, Funkenstraße 5, 76543 Glutstadt, Examplien',
      delivery_note_number: 'LS-2026-4471',
      po_number: 'B-44812',
      carrier: 'Eilbote Logistik',
      tracking_number: 'EB 4471 0098 22',
      delivery_date: '2026-09-16',
      total_packages: '2',
    },
    lines: [
      shipped('MW-1042', 'Akku-Bohrschrauber 18 V', '2', '2', 'Stk'),
      shipped('MW-2210', 'Bohrersatz HSS, 19-teilig', '4', '3', 'Satz'),
      shipped('MW-3307', 'Schutzbrille, klar', '12', '12', 'Stk'),
      shipped('MW-5120', 'Arbeitshandschuhe, Gr. 10', '10', '6', 'Paar'),
    ],
    printsTotal: true,
    extra: { supplierAddress: MUEHLBACH.address, goodsValue: '416.10' },
  }),
  deliveryNote({
    file: 'delivery-note-03.pdf',
    note: 'A British pottery’s note with a declared value in GBP for insurance; no tracking number.',
    style: { lang: 'en', date: 'dmy/', number: 'en', layout: 3, currency: 'none' },
    currency: 'GBP',
    printed: 'GBP',
    fields: {
      supplier_name: 'Hollowreed Ceramics',
      customer_name: OLD_FERRY.name,
      ship_to_address: OLD_FERRY.address,
      delivery_note_number: 'HRC-0577',
      po_number: 'OFG-112',
      carrier: 'Puffin Parcel Lines',
      tracking_number: '',
      delivery_date: '2026-10-08',
      total_packages: '4',
    },
    lines: [
      shipped('HRC-MUG-08', 'Stoneware mug, sea green', '24', '24', 'pcs'),
      shipped('HRC-PLT-26', 'Dinner plate, 26 cm', '30', '30', 'pcs'),
      shipped('HRC-BWL-15', 'Breakfast bowl, 15 cm', '20', '20', 'pcs'),
    ],
    printsTotal: true,
    extra: { supplierAddress: 'Kiln Cottage, Reedmoor RM5 2QP, Examplia', goodsValue: '1184.00' },
  }),
  deliveryNote({
    file: 'delivery-note-04.pdf',
    note: 'A French bon de livraison in a typewriter face: no ordered column and no item codes.',
    style: { lang: 'fr', date: 'dmy/', number: 'fr', layout: 4, currency: 'none' },
    currency: '',
    printed: '',
    fields: {
      supplier_name: VERLAINE.name,
      customer_name: HERON.name,
      ship_to_address: HERON.address,
      delivery_note_number: 'BL-0342',
      po_number: 'BC-1187',
      carrier: 'Transports Albatros',
      tracking_number: 'TA-2209-77314',
      delivery_date: '2026-09-24',
      total_packages: '2',
    },
    lines: [shipped('', 'Affiches A2, impression quadrichromie', '', '150', 'ex.'), shipped('', 'Marque-pages illustrés', '', '500', 'ex.')],
    printsTotal: true,
    extra: { supplierAddress: VERLAINE.address },
  }),
  deliveryNote({
    file: 'delivery-note-05.pdf',
    note: 'The vessels of purchase order 03 with a short delivery of clamps: sidebar, serif face, no total quantity.',
    style: { lang: 'en', date: 'mdy/', number: 'en', layout: 5, currency: 'none' },
    currency: '',
    printed: '',
    fields: {
      supplier_name: JUNIPER.name,
      customer_name: CINDERPINE.name,
      ship_to_address: 'Warehouse B, 81 Hopvine Street, Barleyport, EX 00981, Examplia',
      delivery_note_number: 'JSF-DN-1206',
      po_number: '2026-0457',
      carrier: 'Red Mesa Freight',
      tracking_number: 'RMF 8830 2214 7',
      delivery_date: '2026-10-27',
      total_packages: '5',
    },
    lines: [
      shipped('JSF-FV-500', 'Fermentation vessel, 500 L', '2', '2', 'ea'),
      shipped('JSF-VL-02', 'Sanitary valve, 2 in', '6', '6', 'ea'),
      shipped('JSF-CL-15', 'Tri-clamp, 1.5 in', '24', '20', 'ea'),
    ],
    printsTotal: false,
    extra: { supplierAddress: JUNIPER.address },
  }),
]

// Quotes -----------------------------------------------------------------------------------------

function quote(o: {
  file: string
  note: string
  style: PrintStyle
  currency: string
  printed: string
  parties: Record<string, string>
  meta: Record<string, string>
  lines: Priced[]
  rate: string
  /** The discount as an amount, or as a percentage of the subtotal ("5%"). */
  discount: string
}): EvalDocument {
  const lines = withAmounts(o.lines)
  const subtotal = plus(...lines.map((l) => l.amount))
  const discount = o.discount.endsWith('%') ? percentOf(subtotal, o.discount.slice(0, -1)) : o.discount
  const t = totals(lines, o.rate, discount, '0.00')
  return {
    file: o.file,
    docType: 'quote',
    note: o.note,
    style: o.style,
    fields: {
      ...LANGUAGE(o.style.lang),
      currency: o.currency,
      currency_as_printed: o.printed,
      ...o.parties,
      ...o.meta,
      subtotal: t.subtotal,
      discount_total: t.discount_total,
      tax_total: t.tax_total,
      total: t.total,
    },
    lines: lines.map(({ description, item_code, quantity, unit, unit_price, amount }) => ({ description, item_code, quantity, unit, unit_price, amount })),
    extra: { rate: o.rate, ...(o.discount.endsWith('%') ? { discountRate: o.discount.slice(0, -1) } : {}) },
  }
}

export const QUOTES: EvalDocument[] = [
  quote({
    file: 'quote-01.pdf',
    note: 'An event hire quote: logo left, long English dates, a discount of 0.00.',
    style: { lang: 'en', date: 'long-en', number: 'en', layout: 1, currency: 'before' },
    currency: 'EUR',
    printed: 'EUR',
    parties: {
      supplier_name: 'Brightfern Event Hire',
      supplier_address: '14 Marquee Lane, Pennacombe PC2 5TT, Examplia',
      customer_name: MARROWFIELD.name,
      customer_address: MARROWFIELD.address,
    },
    meta: { quote_number: 'BEH-Q-0619', payment_terms: '30% deposit on booking', quote_date: '2026-10-02', valid_until: '2026-11-01' },
    lines: [
      item('BEH-MQ-6', 'Marquee, 6 x 12 m', '1', 'day', '640.00'),
      item('BEH-TB-18', 'Trestle table, 1.8 m', '20', 'pcs', '7.50'),
      item('BEH-CH-F', 'Folding chair', '120', 'pcs', '1.40'),
      item('BEH-LT-S', 'String lights, 20 m', '4', 'set', '22.00'),
    ],
    rate: '19',
    discount: '0.00',
  }),
  quote({
    file: 'quote-02.pdf',
    note: 'An Italian oven maker’s preventivo: coloured band, amounts as 3.200,00 €, sconto and IVA 22%.',
    style: { lang: 'it', date: 'dmy/', number: 'eu', layout: 2, currency: 'after' },
    currency: 'EUR',
    printed: '€',
    parties: {
      supplier_name: 'Fornaci Ventodoro S.r.l.',
      supplier_address: 'Via delle Ceramiche 18, 45678 Collerosa, Esemplia',
      customer_name: 'Trattoria Il Gabbiano',
      customer_address: 'Piazza del Porto 3, 56789 Marebello, Esemplia',
    },
    meta: { quote_number: 'PV-2026-211', payment_terms: 'Pagamento a 30 giorni', quote_date: '2026-10-09', valid_until: '2026-11-08' },
    lines: [
      item('FV-FL-90', 'Forno a legna, diametro 90 cm', '1', 'pz', '3200.00'),
      item('FV-INS-1', 'Installazione e collaudo', '1', 'pz', '450.00'),
      item('FV-PL-3', 'Pala per pizza, alluminio', '3', 'pz', '28.00'),
    ],
    rate: '22',
    discount: '150.00',
  }),
  quote({
    file: 'quote-03.pdf',
    note: 'A US roofing estimate on Letter paper: centred letterhead, no item codes, a 5% discount, tax 6.25%.',
    style: { lang: 'en', date: 'long-us', number: 'en', layout: 3, currency: 'before' },
    currency: 'USD',
    printed: 'USD',
    parties: {
      supplier_name: 'Granite Owl Roofing Co.',
      supplier_address: '55 Slate Hollow Road, Pinecrest Mills, EX 00627, Examplia',
      customer_name: COYOTE.name,
      customer_address: COYOTE.address,
    },
    meta: { quote_number: 'GOR-3381', payment_terms: 'Net 15 after completion', quote_date: '2026-10-14', valid_until: '2026-12-13' },
    lines: [
      item('', 'Tear-off of existing shingles', '22', 'sq', '85.00'),
      item('', 'Architectural shingles, installed', '22', 'sq', '310.00'),
      item('', 'Ridge vent', '48', 'ft', '7.25'),
      item('', 'Dumpster rental', '1', 'ea', '425.00'),
    ],
    rate: '6.25',
    discount: '5%',
  }),
  quote({
    file: 'quote-04.pdf',
    note: 'A Swiss carpenter’s Offerte in a typewriter face: CHF 1’234.50, a Rabatt, MWST 8.1%.',
    style: { lang: 'de', date: 'dmy.', number: 'ch', layout: 4, currency: 'before' },
    currency: 'CHF',
    printed: 'CHF',
    parties: {
      supplier_name: 'Holzwerk Tannenhang GmbH',
      supplier_address: 'Sägereiweg 6, 7777 Harzbach, Examplien',
      customer_name: ALPENBLICK.name,
      customer_address: ALPENBLICK.address,
    },
    meta: { quote_number: 'OF-26-0145', payment_terms: '50 % Anzahlung, Rest nach Montage', quote_date: '2026-10-19', valid_until: '2026-11-18' },
    lines: [
      item('HT-TF-01', 'Terrassenboden Lärche, verlegt', '64', 'm2', '118.00'),
      item('HT-GL-02', 'Geländer Lärche', '22', 'm', '145.00'),
      item('HT-MO-00', 'Montage', '16', 'h', '92.00'),
    ],
    rate: '8.1',
    discount: '300.00',
  }),
  quote({
    file: 'quote-05.pdf',
    note: 'A British joinery quote with a sidebar, serif face, pounds; no payment terms.',
    style: { lang: 'en', date: 'dmy/', number: 'en', layout: 5, currency: 'before' },
    currency: 'GBP',
    printed: '£',
    parties: {
      supplier_name: 'Seabright Joinery',
      supplier_address: '7 Driftwood Yard, Shingleton SH4 2WE, Examplia',
      customer_name: LARKSPUR.name,
      customer_address: LARKSPUR.address,
    },
    meta: { quote_number: 'SJ-0412', payment_terms: '', quote_date: '2026-10-22', valid_until: '2026-11-21' },
    lines: [
      item('SJ-RD-1', 'Reception desk, oak veneer', '1', 'pcs', '1450.00'),
      item('SJ-SH-4', 'Wall shelving, 4 bays', '2', 'set', '380.00'),
      item('SJ-FT-0', 'Fitting', '8', 'h', '42.00'),
    ],
    rate: '20',
    discount: '0.00',
  }),
]

/** All 30, in the order the runner sends them. */
export const EVAL_DOCUMENTS: EvalDocument[] = [...INVOICES, ...RECEIPTS, ...BANK_STATEMENTS, ...PURCHASE_ORDERS, ...DELIVERY_NOTES, ...QUOTES]

/** Where the files and the expected results are committed. */
export const DOCUMENTS_DIR = new URL('./documents/', import.meta.url)
export const EXPECTED_DIR = new URL('./expected/', import.meta.url)

export const DISCLAIMER: Record<Lang, string> = {
  en: 'Fictitious document for the doc-extract eval. Every name, address and number on it is invented.',
  de: 'Fiktives Dokument für die doc-extract-Auswertung. Alle Namen, Adressen und Nummern sind erfunden.',
  fr: 'Document fictif pour l’évaluation doc-extract. Tous les noms, adresses et numéros sont inventés.',
  es: 'Documento ficticio para la evaluación de doc-extract. Todos los nombres, direcciones y números son inventados.',
  nl: 'Fictief document voor de doc-extract-evaluatie. Alle namen, adressen en nummers zijn verzonnen.',
  it: 'Documento fittizio per la valutazione di doc-extract. Tutti i nomi, gli indirizzi e i numeri sono inventati.',
}
