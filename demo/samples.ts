// What the seven demo samples print (PRD F13, OQ-25, OQ-38; issue #41 criteria 1 to 3): every
// value of every field and line, as the type's fields name them, with '' for a field the document
// does not print. make-samples.ts draws the documents from these values, and each sample's stored
// result in the demo_documents migration holds the same values, which demo/samples.test.ts
// compares. Every name, address and number is invented; "Examplia" is no real country and "EX" no
// real country code.

export interface SampleValues {
  /** The file name in demo/samples/ and the demo bucket: `{slug}.{ext}`. */
  file: string
  docType: 'invoice' | 'receipt' | 'bank_statement' | 'purchase_order' | 'delivery_note' | 'quote'
  /** Every header field of the type. */
  fields: Record<string, string>
  /** Each line's cells, a bank statement's transactions among them. */
  lines: Record<string, string>[]
}

/** Where the files are committed, each named as its demo_documents.file_path. */
export const SAMPLES_DIR = new URL('./samples/', import.meta.url)

export const DISCLAIMER = 'Sample document for the doc-extract demo. Every name, address and number on it is invented.'

const STUDIO = 'Copperfinch Design Studio'
const STUDIO_ADDRESS = 'Unit 3, 88 Harbour Row, Saltmere SM4 9ZZ, Examplia'

const BRAMBLEWOOD = {
  vendor_name: 'Bramblewood Paper Goods Ltd',
  vendor_address: '4 Inkwell Lane, Quillford QF1 2AB, Examplia',
  vendor_tax_id: 'EX123456789',
}

const BRAMBLEWOOD_LINES = [
  {
    description: 'Recycled copy paper A4, 500 sheets',
    item_code: 'PAP-A4-500',
    quantity: '20',
    unit: 'ream',
    unit_price: '6.50',
    tax_rate: '19',
    amount: '130.00',
  },
  {
    description: 'Kraft envelopes C5, box of 250',
    item_code: 'ENV-C5-250',
    quantity: '4',
    unit: 'box',
    unit_price: '18.75',
    tax_rate: '19',
    amount: '75.00',
  },
  {
    description: 'Fountain pen ink, blue-black, 50 ml',
    item_code: 'INK-BB-50',
    quantity: '10',
    unit: 'pcs',
    unit_price: '4.20',
    tax_rate: '19',
    amount: '42.00',
  },
]

/** The invoice whose printed total is 10.00 more than its subtotal, shipping and tax: A3 fails. */
export const INVOICE_TOTAL_MISMATCH: SampleValues = {
  file: 'invoice-total-mismatch.pdf',
  docType: 'invoice',
  fields: {
    language: 'en',
    currency: 'EUR',
    currency_as_printed: 'EUR',
    ...BRAMBLEWOOD,
    customer_name: STUDIO,
    customer_address: STUDIO_ADDRESS,
    customer_tax_id: 'EX987654321',
    invoice_number: 'BPG-2026-0142',
    purchase_order_number: 'CDS-PO-298',
    payment_terms: 'Net 30',
    invoice_date: '2026-09-14',
    due_date: '2026-10-14',
    subtotal: '247.00',
    tax_total: '46.93',
    shipping: '9.50',
    discount_total: '0.00',
    total: '313.43',
    amount_paid: '',
    amount_due: '313.43',
  },
  lines: BRAMBLEWOOD_LINES,
}

/** The same invoice sent again, its total put right: the same vendor and number, so U1 fails. */
export const INVOICE_DUPLICATE: SampleValues = {
  file: 'invoice-duplicate.pdf',
  docType: 'invoice',
  fields: {
    ...INVOICE_TOTAL_MISMATCH.fields,
    total: '303.43',
    amount_due: '303.43',
  },
  lines: BRAMBLEWOOD_LINES,
}

/** A café's till receipt, photographed: its tax number and receipt number are faded. */
export const RECEIPT_PHOTO: SampleValues = {
  file: 'receipt-photo.png',
  docType: 'receipt',
  fields: {
    language: 'en',
    currency: 'EUR',
    currency_as_printed: 'EUR',
    merchant_name: 'THE GILDED SPOON CAFE',
    merchant_address: '12 PEBBLE MARKET, BRIGHTWATER, EXAMPLIA',
    merchant_tax_id: 'EX 555 0101 22',
    receipt_number: '004817',
    payment_method: 'VISA',
    card_last4: '4821',
    transaction_date: '2026-09-05',
    transaction_time: '12:47',
    subtotal: '15.90',
    tax_total: '1.59',
    tip: '1.50',
    total: '18.99',
  },
  lines: [
    { description: 'FLAT WHITE', quantity: '2', unit_price: '3.40', amount: '6.80' },
    { description: 'OAT PORRIDGE', quantity: '1', unit_price: '5.90', amount: '5.90' },
    { description: 'BLUEBERRY MUFFIN', quantity: '1', unit_price: '3.20', amount: '3.20' },
  ],
}

const tx = (date: string, description: string, reference: string, amount: string, balance: string) => ({
  date,
  description,
  reference,
  amount,
  balance,
})

/** A month of one account's transactions over two pages; every balance and total adds up. */
export const BANK_STATEMENT: SampleValues = {
  file: 'bank-statement.pdf',
  docType: 'bank_statement',
  fields: {
    language: 'en',
    currency: 'EUR',
    currency_as_printed: 'EUR',
    bank_name: 'Fernhollow Mutual Bank',
    account_holder: STUDIO,
    account_number_last4: '5678',
    iban_last4: '5678',
    statement_period_start: '2026-09-01',
    statement_period_end: '2026-09-30',
    opening_balance: '2450.00',
    closing_balance: '2509.65',
    total_credits: '3562.34',
    total_debits: '3502.69',
  },
  lines: [
    tx('2026-09-01', 'Card payment Bramblewood Paper Goods', 'CP-0901-77', '-84.20', '2365.80'),
    tx('2026-09-02', 'Client payment Saltmere Rowing Club', 'INV-CDS-0087', '1200.00', '3565.80'),
    tx('2026-09-03', 'Rent Harbour Row Studios', 'RENT-SEP', '-950.00', '2615.80'),
    tx('2026-09-05', 'Card payment The Gilded Spoon Cafe', 'CP-0905-12', '-18.99', '2596.81'),
    tx('2026-09-07', 'Direct debit Brightwater Power', 'DD-BWP-4471', '-112.40', '2484.41'),
    tx('2026-09-08', 'Client payment Quillford Theatre Trust', 'INV-CDS-0088', '640.00', '3124.41'),
    tx('2026-09-10', 'Transfer to savings', 'TRF-0910', '-300.00', '2824.41'),
    tx('2026-09-11', 'Card payment Pebble Market Hardware', 'CP-0911-03', '-46.75', '2777.66'),
    tx('2026-09-12', 'Direct debit Examplia Telecom', 'DD-EXT-2209', '-39.90', '2737.76'),
    tx('2026-09-14', 'Client payment Lanternfish Books', 'INV-CDS-0089', '415.50', '3153.26'),
    tx('2026-09-15', 'Card payment Inkwell Lane Printers', 'CP-0915-41', '-128.00', '3025.26'),
    tx('2026-09-16', 'Subscription Sketchloom Software', 'SUB-SKL-09', '-24.00', '3001.26'),
    tx('2026-09-18', 'Card payment Copper Kettle Deli', 'CP-0918-08', '-12.60', '2988.66'),
    tx('2026-09-19', 'Client payment Saltmere Rowing Club', 'INV-CDS-0090', '300.00', '3288.66'),
    tx('2026-09-21', 'Direct debit Brightwater Insurance', 'DD-BWI-1180', '-67.25', '3221.41'),
    tx('2026-09-22', 'Card payment Bramblewood Paper Goods', 'CP-0922-19', '-53.10', '3168.31'),
    tx('2026-09-24', 'Client payment Mossgate Bakery', 'INV-CDS-0091', '780.00', '3948.31'),
    tx('2026-09-25', 'Payroll September', 'PAY-SEP-01', '-1650.00', '2298.31'),
    tx('2026-09-26', 'Card payment Harbour Row Parking', 'CP-0926-02', '-9.00', '2289.31'),
    tx('2026-09-28', 'Account fee September', 'FEE-0928', '-6.50', '2282.81'),
    tx('2026-09-29', 'Client payment Quillford Theatre Trust', 'INV-CDS-0092', '225.00', '2507.81'),
    tx('2026-09-30', 'Interest', 'INT-SEP', '1.84', '2509.65'),
  ],
}

const LANTERNFISH = { name: 'Lanternfish Furniture Works', address: '17 Kiln Yard, Mossgate MG2 7QT, Examplia' }

/** The studio's order for office furniture; its lines, shipping and tax add up. */
export const PURCHASE_ORDER: SampleValues = {
  file: 'purchase-order.pdf',
  docType: 'purchase_order',
  fields: {
    language: 'en',
    currency: 'EUR',
    currency_as_printed: 'EUR',
    buyer_name: STUDIO,
    buyer_address: STUDIO_ADDRESS,
    supplier_name: LANTERNFISH.name,
    supplier_address: LANTERNFISH.address,
    ship_to_address: STUDIO_ADDRESS,
    po_number: 'CDS-PO-311',
    payment_terms: 'Net 30',
    order_date: '2026-09-02',
    requested_delivery_date: '2026-09-16',
    subtotal: '1521.00',
    tax_total: '288.99',
    shipping: '45.00',
    total: '1854.99',
  },
  lines: [
    { item_code: 'LFW-DSK-140', description: 'Oak standing desk, 140 cm', quantity: '2', unit: 'pcs', unit_price: '389.00', amount: '778.00' },
    { item_code: 'LFW-CHR-02', description: 'Task chair, charcoal', quantity: '4', unit: 'pcs', unit_price: '149.50', amount: '598.00' },
    { item_code: 'LFW-LMP-07', description: 'Desk lamp, brass', quantity: '4', unit: 'pcs', unit_price: '36.25', amount: '145.00' },
  ],
}

/** The delivery of that order: everything ordered, delivered. No prices, so no currency. */
export const DELIVERY_NOTE: SampleValues = {
  file: 'delivery-note.pdf',
  docType: 'delivery_note',
  fields: {
    language: 'en',
    currency: '',
    currency_as_printed: '',
    supplier_name: LANTERNFISH.name,
    customer_name: STUDIO,
    ship_to_address: STUDIO_ADDRESS,
    delivery_note_number: 'LFW-DN-5520',
    po_number: 'CDS-PO-311',
    carrier: 'Kestrel Freight',
    tracking_number: 'KF-7741-0093-EX',
    delivery_date: '2026-09-15',
    total_packages: '6',
    total_quantity: '10',
  },
  lines: [
    { item_code: 'LFW-DSK-140', description: 'Oak standing desk, 140 cm', quantity_ordered: '2', quantity_delivered: '2', unit: 'pcs' },
    { item_code: 'LFW-CHR-02', description: 'Task chair, charcoal', quantity_ordered: '4', quantity_delivered: '4', unit: 'pcs' },
    { item_code: 'LFW-LMP-07', description: 'Desk lamp, brass', quantity_ordered: '4', quantity_delivered: '4', unit: 'pcs' },
  ],
}

/** A sign maker's quote whose valid-until date is a month before its own date: D2 fails. */
export const QUOTE: SampleValues = {
  file: 'quote-date-error.pdf',
  docType: 'quote',
  fields: {
    language: 'en',
    currency: 'EUR',
    currency_as_printed: 'EUR',
    supplier_name: 'Saltmere Signworks',
    supplier_address: '2 Ropewalk Quay, Saltmere SM1 4LP, Examplia',
    customer_name: STUDIO,
    customer_address: STUDIO_ADDRESS,
    quote_number: 'SSW-Q-2026-058',
    payment_terms: '50% on order, balance on installation',
    quote_date: '2026-10-05',
    valid_until: '2026-09-05',
    subtotal: '1026.00',
    discount_total: '51.30',
    tax_total: '185.19',
    total: '1159.89',
  },
  lines: [
    {
      description: 'Shopfront sign, painted aluminium, 240 x 60 cm',
      item_code: 'SSW-SF-240',
      quantity: '1',
      unit: 'pcs',
      unit_price: '680.00',
      amount: '680.00',
    },
    { description: 'Window vinyl lettering', item_code: 'SSW-VL-01', quantity: '3', unit: 'sqm', unit_price: '42.00', amount: '126.00' },
    { description: 'Installation', item_code: '', quantity: '4', unit: 'h', unit_price: '55.00', amount: '220.00' },
  ],
}

export const SAMPLES: SampleValues[] = [
  INVOICE_TOTAL_MISMATCH,
  INVOICE_DUPLICATE,
  RECEIPT_PHOTO,
  BANK_STATEMENT,
  PURCHASE_ORDER,
  DELIVERY_NOTE,
  QUOTE,
]
