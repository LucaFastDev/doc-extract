-- Milestone 11, the public demo (PRD F13, section 6; ARCHITECTURE.md sections 4.2, 5 and 10; Lead
-- rulings 1 and 2 on #41): the demo_documents table, the private demo bucket and its read policy,
-- and the seven samples' rows with their stored results, published. The rows arrive by this
-- migration everywhere, locally, in CI and in production; the files are uploaded separately (the
-- e2e setup and `npm run demo:upload` locally, the operator in production, docs/go-live.md).

create table public.demo_documents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  doc_type text not null check (doc_type in ('invoice', 'receipt', 'bank_statement', 'purchase_order', 'delivery_note', 'quote')),
  title text not null,
  -- What the sample shows, one short line on /demo, such as "a failed total check".
  summary text not null,
  -- The object in the demo bucket, `{slug}.{ext}`; also the file name the demo shows and exports.
  file_path text not null unique,
  page_count int not null check (page_count between 1 and 10),
  -- The stored extraction: doc_type, the amount_tolerance its checks ran with, fields (path, kind,
  -- extracted_value, confidence, flags, as extraction_fields stores them) and checks (check_id,
  -- status, field_paths, message, as check_results stores them).
  result jsonb not null,
  sort_order int not null,
  published boolean not null default false
);

alter table public.demo_documents enable row level security;
revoke all on table public.demo_documents from anon, authenticated;

-- Visitors, signed in or not, read the published samples; nobody writes from a client.
create policy demo_documents_select on public.demo_documents
  for select to anon, authenticated
  using (published);

grant select on table public.demo_documents to anon, authenticated;

-- Private: a public bucket would serve every object by URL, an unpublished sample's file too
-- (section 5). The same limits as the documents bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('demo', 'demo', false, 10 * 1024 * 1024,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

-- Anyone reads an object that a published sample names as its file_path. The subquery reads
-- demo_documents as the caller, through the policy above, so it sees published rows only.
create policy demo_objects_select on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'demo'
    and exists (
      select 1 from public.demo_documents d
      where d.published and d.file_path = objects.name
    )
  );

-- No insert, update or delete policy: objects are written only through the Storage API with the
-- service role.

-- The samples. Each result holds the values the document prints, as Claude would return them, with
-- the confidences chosen so the receipt's faded fields fall below the 0.8 threshold (OQ-8); the
-- checks and flags are what process-queue's prepareResult gives for them, and the duplicate's U1 what
-- record_extraction stores against the first invoice (demo/samples.test.ts checks both).

insert into public.demo_documents (slug, doc_type, title, summary, file_path, page_count, sort_order, published, result) values
-- 1. invoice-total-mismatch.pdf
('invoice-total-mismatch', 'invoice', 'Invoice with a wrong total',
 'A failed total check: the subtotal, shipping and tax add up to 303.43, but the invoice prints 313.43.',
 'invoice-total-mismatch.pdf', 1, 1, true, $result$
{
  "doc_type": "invoice",
  "amount_tolerance": "0.01",
  "fields": [
    {"path": "language", "kind": "text", "extracted_value": "en", "confidence": 0.99, "flags": []},
    {"path": "currency", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "currency_as_printed", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "vendor_name", "kind": "text", "extracted_value": "Bramblewood Paper Goods Ltd", "confidence": 0.98, "flags": []},
    {"path": "vendor_address", "kind": "text", "extracted_value": "4 Inkwell Lane, Quillford QF1 2AB, Examplia", "confidence": 0.98, "flags": []},
    {"path": "vendor_tax_id", "kind": "text", "extracted_value": "EX123456789", "confidence": 0.98, "flags": []},
    {"path": "customer_name", "kind": "text", "extracted_value": "Copperfinch Design Studio", "confidence": 0.98, "flags": []},
    {"path": "customer_address", "kind": "text", "extracted_value": "Unit 3, 88 Harbour Row, Saltmere SM4 9ZZ, Examplia", "confidence": 0.98, "flags": []},
    {"path": "customer_tax_id", "kind": "text", "extracted_value": "EX987654321", "confidence": 0.98, "flags": []},
    {"path": "invoice_number", "kind": "text", "extracted_value": "BPG-2026-0142", "confidence": 0.98, "flags": []},
    {"path": "purchase_order_number", "kind": "text", "extracted_value": "CDS-PO-298", "confidence": 0.98, "flags": []},
    {"path": "payment_terms", "kind": "text", "extracted_value": "Net 30", "confidence": 0.98, "flags": []},
    {"path": "invoice_date", "kind": "date", "extracted_value": "2026-09-14", "confidence": 0.97, "flags": []},
    {"path": "due_date", "kind": "date", "extracted_value": "2026-10-14", "confidence": 0.97, "flags": []},
    {"path": "subtotal", "kind": "amount", "extracted_value": "247.00", "confidence": 0.97, "flags": ["check_failed"]},
    {"path": "tax_total", "kind": "amount", "extracted_value": "46.93", "confidence": 0.97, "flags": ["check_failed"]},
    {"path": "shipping", "kind": "amount", "extracted_value": "9.50", "confidence": 0.97, "flags": ["check_failed"]},
    {"path": "discount_total", "kind": "amount", "extracted_value": "0.00", "confidence": 0.97, "flags": ["check_failed"]},
    {"path": "total", "kind": "amount", "extracted_value": "313.43", "confidence": 0.97, "flags": ["check_failed"]},
    {"path": "amount_paid", "kind": "amount", "extracted_value": null, "confidence": 0.9, "flags": []},
    {"path": "amount_due", "kind": "amount", "extracted_value": "313.43", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].description", "kind": "text", "extracted_value": "Recycled copy paper A4, 500 sheets", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].item_code", "kind": "text", "extracted_value": "PAP-A4-500", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].quantity", "kind": "number", "extracted_value": "20", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].unit", "kind": "text", "extracted_value": "ream", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].unit_price", "kind": "amount", "extracted_value": "6.50", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].tax_rate", "kind": "percent", "extracted_value": "19", "confidence": 0.95, "flags": []},
    {"path": "line_items[0].amount", "kind": "amount", "extracted_value": "130.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].description", "kind": "text", "extracted_value": "Kraft envelopes C5, box of 250", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].item_code", "kind": "text", "extracted_value": "ENV-C5-250", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].quantity", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].unit", "kind": "text", "extracted_value": "box", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].unit_price", "kind": "amount", "extracted_value": "18.75", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].tax_rate", "kind": "percent", "extracted_value": "19", "confidence": 0.95, "flags": []},
    {"path": "line_items[1].amount", "kind": "amount", "extracted_value": "75.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].description", "kind": "text", "extracted_value": "Fountain pen ink, blue-black, 50 ml", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].item_code", "kind": "text", "extracted_value": "INK-BB-50", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].quantity", "kind": "number", "extracted_value": "10", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].unit_price", "kind": "amount", "extracted_value": "4.20", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].tax_rate", "kind": "percent", "extracted_value": "19", "confidence": 0.95, "flags": []},
    {"path": "line_items[2].amount", "kind": "amount", "extracted_value": "42.00", "confidence": 0.97, "flags": []}
  ],
  "checks": [
    {"check_id": "A1", "status": "pass", "field_paths": ["line_items[0].quantity","line_items[0].unit_price","line_items[0].amount","line_items[1].quantity","line_items[1].unit_price","line_items[1].amount","line_items[2].quantity","line_items[2].unit_price","line_items[2].amount"], "message": null},
    {"check_id": "A2", "status": "pass", "field_paths": ["line_items[0].amount","line_items[1].amount","line_items[2].amount","subtotal"], "message": null},
    {"check_id": "A3", "status": "fail", "field_paths": ["subtotal","discount_total","shipping","tax_total","total"], "message": "Subtotal 247.00 − discount 0.00 + shipping 9.50 + tax 46.93 = 303.43; total is 313.43"},
    {"check_id": "A4", "status": "skipped", "field_paths": ["total","amount_paid","amount_due"], "message": "Skipped: no amount paid is printed."},
    {"check_id": "D1", "status": "pass", "field_paths": ["invoice_date"], "message": null},
    {"check_id": "D2", "status": "pass", "field_paths": ["invoice_date","due_date"], "message": null},
    {"check_id": "U1", "status": "pass", "field_paths": ["vendor_tax_id","invoice_number"], "message": null}
  ]
}
$result$::jsonb),

-- 2. invoice-duplicate.pdf
('invoice-duplicate', 'invoice', 'The same invoice, sent again',
 'A duplicate: the same vendor and invoice number as the first invoice, reissued with its total put right.',
 'invoice-duplicate.pdf', 1, 2, true, $result$
{
  "doc_type": "invoice",
  "amount_tolerance": "0.01",
  "fields": [
    {"path": "language", "kind": "text", "extracted_value": "en", "confidence": 0.99, "flags": []},
    {"path": "currency", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "currency_as_printed", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "vendor_name", "kind": "text", "extracted_value": "Bramblewood Paper Goods Ltd", "confidence": 0.98, "flags": []},
    {"path": "vendor_address", "kind": "text", "extracted_value": "4 Inkwell Lane, Quillford QF1 2AB, Examplia", "confidence": 0.98, "flags": []},
    {"path": "vendor_tax_id", "kind": "text", "extracted_value": "EX123456789", "confidence": 0.98, "flags": ["duplicate"]},
    {"path": "customer_name", "kind": "text", "extracted_value": "Copperfinch Design Studio", "confidence": 0.98, "flags": []},
    {"path": "customer_address", "kind": "text", "extracted_value": "Unit 3, 88 Harbour Row, Saltmere SM4 9ZZ, Examplia", "confidence": 0.98, "flags": []},
    {"path": "customer_tax_id", "kind": "text", "extracted_value": "EX987654321", "confidence": 0.98, "flags": []},
    {"path": "invoice_number", "kind": "text", "extracted_value": "BPG-2026-0142", "confidence": 0.98, "flags": ["duplicate"]},
    {"path": "purchase_order_number", "kind": "text", "extracted_value": "CDS-PO-298", "confidence": 0.98, "flags": []},
    {"path": "payment_terms", "kind": "text", "extracted_value": "Net 30", "confidence": 0.98, "flags": []},
    {"path": "invoice_date", "kind": "date", "extracted_value": "2026-09-14", "confidence": 0.97, "flags": []},
    {"path": "due_date", "kind": "date", "extracted_value": "2026-10-14", "confidence": 0.97, "flags": []},
    {"path": "subtotal", "kind": "amount", "extracted_value": "247.00", "confidence": 0.97, "flags": []},
    {"path": "tax_total", "kind": "amount", "extracted_value": "46.93", "confidence": 0.97, "flags": []},
    {"path": "shipping", "kind": "amount", "extracted_value": "9.50", "confidence": 0.97, "flags": []},
    {"path": "discount_total", "kind": "amount", "extracted_value": "0.00", "confidence": 0.97, "flags": []},
    {"path": "total", "kind": "amount", "extracted_value": "303.43", "confidence": 0.97, "flags": []},
    {"path": "amount_paid", "kind": "amount", "extracted_value": null, "confidence": 0.9, "flags": []},
    {"path": "amount_due", "kind": "amount", "extracted_value": "303.43", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].description", "kind": "text", "extracted_value": "Recycled copy paper A4, 500 sheets", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].item_code", "kind": "text", "extracted_value": "PAP-A4-500", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].quantity", "kind": "number", "extracted_value": "20", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].unit", "kind": "text", "extracted_value": "ream", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].unit_price", "kind": "amount", "extracted_value": "6.50", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].tax_rate", "kind": "percent", "extracted_value": "19", "confidence": 0.95, "flags": []},
    {"path": "line_items[0].amount", "kind": "amount", "extracted_value": "130.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].description", "kind": "text", "extracted_value": "Kraft envelopes C5, box of 250", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].item_code", "kind": "text", "extracted_value": "ENV-C5-250", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].quantity", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].unit", "kind": "text", "extracted_value": "box", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].unit_price", "kind": "amount", "extracted_value": "18.75", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].tax_rate", "kind": "percent", "extracted_value": "19", "confidence": 0.95, "flags": []},
    {"path": "line_items[1].amount", "kind": "amount", "extracted_value": "75.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].description", "kind": "text", "extracted_value": "Fountain pen ink, blue-black, 50 ml", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].item_code", "kind": "text", "extracted_value": "INK-BB-50", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].quantity", "kind": "number", "extracted_value": "10", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].unit_price", "kind": "amount", "extracted_value": "4.20", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].tax_rate", "kind": "percent", "extracted_value": "19", "confidence": 0.95, "flags": []},
    {"path": "line_items[2].amount", "kind": "amount", "extracted_value": "42.00", "confidence": 0.97, "flags": []}
  ],
  "checks": [
    {"check_id": "A1", "status": "pass", "field_paths": ["line_items[0].quantity","line_items[0].unit_price","line_items[0].amount","line_items[1].quantity","line_items[1].unit_price","line_items[1].amount","line_items[2].quantity","line_items[2].unit_price","line_items[2].amount"], "message": null},
    {"check_id": "A2", "status": "pass", "field_paths": ["line_items[0].amount","line_items[1].amount","line_items[2].amount","subtotal"], "message": null},
    {"check_id": "A3", "status": "pass", "field_paths": ["subtotal","discount_total","shipping","tax_total","total"], "message": null},
    {"check_id": "A4", "status": "skipped", "field_paths": ["total","amount_paid","amount_due"], "message": "Skipped: no amount paid is printed."},
    {"check_id": "D1", "status": "pass", "field_paths": ["invoice_date"], "message": null},
    {"check_id": "D2", "status": "pass", "field_paths": ["invoice_date","due_date"], "message": null},
    {"check_id": "U1", "status": "fail", "field_paths": ["vendor_tax_id","invoice_number"], "message": "Duplicate of \"invoice-total-mismatch.pdf\": the same vendor and invoice number."}
  ]
}
$result$::jsonb),

-- 3. receipt-photo.png
('receipt-photo', 'receipt', 'Photographed café receipt',
 'Low-confidence fields: a photo of a till receipt whose tax number and receipt number are faded.',
 'receipt-photo.png', 1, 3, true, $result$
{
  "doc_type": "receipt",
  "amount_tolerance": "0.01",
  "fields": [
    {"path": "language", "kind": "text", "extracted_value": "en", "confidence": 0.99, "flags": []},
    {"path": "currency", "kind": "text", "extracted_value": "EUR", "confidence": 0.93, "flags": []},
    {"path": "currency_as_printed", "kind": "text", "extracted_value": "EUR", "confidence": 0.93, "flags": []},
    {"path": "merchant_name", "kind": "text", "extracted_value": "THE GILDED SPOON CAFE", "confidence": 0.93, "flags": []},
    {"path": "merchant_address", "kind": "text", "extracted_value": "12 PEBBLE MARKET, BRIGHTWATER, EXAMPLIA", "confidence": 0.93, "flags": []},
    {"path": "merchant_tax_id", "kind": "text", "extracted_value": "EX 555 0101 22", "confidence": 0.58, "flags": ["low_confidence"]},
    {"path": "receipt_number", "kind": "text", "extracted_value": "004817", "confidence": 0.66, "flags": ["low_confidence"]},
    {"path": "payment_method", "kind": "text", "extracted_value": "VISA", "confidence": 0.93, "flags": []},
    {"path": "card_last4", "kind": "text", "extracted_value": "4821", "confidence": 0.93, "flags": []},
    {"path": "transaction_date", "kind": "date", "extracted_value": "2026-09-05", "confidence": 0.92, "flags": []},
    {"path": "transaction_time", "kind": "text", "extracted_value": "12:47", "confidence": 0.93, "flags": []},
    {"path": "subtotal", "kind": "amount", "extracted_value": "15.90", "confidence": 0.92, "flags": []},
    {"path": "tax_total", "kind": "amount", "extracted_value": "1.59", "confidence": 0.92, "flags": []},
    {"path": "tip", "kind": "amount", "extracted_value": "1.50", "confidence": 0.92, "flags": []},
    {"path": "total", "kind": "amount", "extracted_value": "18.99", "confidence": 0.92, "flags": []},
    {"path": "line_items[0].description", "kind": "text", "extracted_value": "FLAT WHITE", "confidence": 0.93, "flags": []},
    {"path": "line_items[0].quantity", "kind": "number", "extracted_value": "2", "confidence": 0.92, "flags": []},
    {"path": "line_items[0].unit_price", "kind": "amount", "extracted_value": "3.40", "confidence": 0.92, "flags": []},
    {"path": "line_items[0].amount", "kind": "amount", "extracted_value": "6.80", "confidence": 0.92, "flags": []},
    {"path": "line_items[1].description", "kind": "text", "extracted_value": "OAT PORRIDGE", "confidence": 0.93, "flags": []},
    {"path": "line_items[1].quantity", "kind": "number", "extracted_value": "1", "confidence": 0.92, "flags": []},
    {"path": "line_items[1].unit_price", "kind": "amount", "extracted_value": "5.90", "confidence": 0.92, "flags": []},
    {"path": "line_items[1].amount", "kind": "amount", "extracted_value": "5.90", "confidence": 0.92, "flags": []},
    {"path": "line_items[2].description", "kind": "text", "extracted_value": "BLUEBERRY MUFFIN", "confidence": 0.93, "flags": []},
    {"path": "line_items[2].quantity", "kind": "number", "extracted_value": "1", "confidence": 0.92, "flags": []},
    {"path": "line_items[2].unit_price", "kind": "amount", "extracted_value": "3.20", "confidence": 0.92, "flags": []},
    {"path": "line_items[2].amount", "kind": "amount", "extracted_value": "3.20", "confidence": 0.92, "flags": []}
  ],
  "checks": [
    {"check_id": "A1", "status": "pass", "field_paths": ["line_items[0].quantity","line_items[0].unit_price","line_items[0].amount","line_items[1].quantity","line_items[1].unit_price","line_items[1].amount","line_items[2].quantity","line_items[2].unit_price","line_items[2].amount"], "message": null},
    {"check_id": "A2", "status": "pass", "field_paths": ["line_items[0].amount","line_items[1].amount","line_items[2].amount","subtotal"], "message": null},
    {"check_id": "A3", "status": "pass", "field_paths": ["subtotal","tax_total","tip","total"], "message": null},
    {"check_id": "D1", "status": "pass", "field_paths": ["transaction_date"], "message": null},
    {"check_id": "U1", "status": "pass", "field_paths": ["merchant_name","transaction_date","transaction_time","total"], "message": null}
  ]
}
$result$::jsonb),

-- 4. bank-statement.pdf
('bank-statement', 'bank_statement', 'Two-page bank statement',
 'Twenty-two transactions over two pages, whose balances and totals all add up.',
 'bank-statement.pdf', 2, 4, true, $result$
{
  "doc_type": "bank_statement",
  "amount_tolerance": "0.01",
  "fields": [
    {"path": "language", "kind": "text", "extracted_value": "en", "confidence": 0.99, "flags": []},
    {"path": "currency", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "currency_as_printed", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "bank_name", "kind": "text", "extracted_value": "Fernhollow Mutual Bank", "confidence": 0.98, "flags": []},
    {"path": "account_holder", "kind": "text", "extracted_value": "Copperfinch Design Studio", "confidence": 0.98, "flags": []},
    {"path": "account_number_last4", "kind": "text", "extracted_value": "5678", "confidence": 0.98, "flags": []},
    {"path": "iban_last4", "kind": "text", "extracted_value": "5678", "confidence": 0.98, "flags": []},
    {"path": "statement_period_start", "kind": "date", "extracted_value": "2026-09-01", "confidence": 0.97, "flags": []},
    {"path": "statement_period_end", "kind": "date", "extracted_value": "2026-09-30", "confidence": 0.97, "flags": []},
    {"path": "opening_balance", "kind": "amount", "extracted_value": "2450.00", "confidence": 0.97, "flags": []},
    {"path": "closing_balance", "kind": "amount", "extracted_value": "2509.65", "confidence": 0.97, "flags": []},
    {"path": "total_credits", "kind": "amount", "extracted_value": "3562.34", "confidence": 0.97, "flags": []},
    {"path": "total_debits", "kind": "amount", "extracted_value": "3502.69", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].date", "kind": "date", "extracted_value": "2026-09-01", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].description", "kind": "text", "extracted_value": "Card payment Bramblewood Paper Goods", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].reference", "kind": "text", "extracted_value": "CP-0901-77", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].amount", "kind": "amount", "extracted_value": "-84.20", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].balance", "kind": "amount", "extracted_value": "2365.80", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].date", "kind": "date", "extracted_value": "2026-09-02", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].description", "kind": "text", "extracted_value": "Client payment Saltmere Rowing Club", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].reference", "kind": "text", "extracted_value": "INV-CDS-0087", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].amount", "kind": "amount", "extracted_value": "1200.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].balance", "kind": "amount", "extracted_value": "3565.80", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].date", "kind": "date", "extracted_value": "2026-09-03", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].description", "kind": "text", "extracted_value": "Rent Harbour Row Studios", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].reference", "kind": "text", "extracted_value": "RENT-SEP", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].amount", "kind": "amount", "extracted_value": "-950.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].balance", "kind": "amount", "extracted_value": "2615.80", "confidence": 0.97, "flags": []},
    {"path": "line_items[3].date", "kind": "date", "extracted_value": "2026-09-05", "confidence": 0.97, "flags": []},
    {"path": "line_items[3].description", "kind": "text", "extracted_value": "Card payment The Gilded Spoon Cafe", "confidence": 0.98, "flags": []},
    {"path": "line_items[3].reference", "kind": "text", "extracted_value": "CP-0905-12", "confidence": 0.98, "flags": []},
    {"path": "line_items[3].amount", "kind": "amount", "extracted_value": "-18.99", "confidence": 0.97, "flags": []},
    {"path": "line_items[3].balance", "kind": "amount", "extracted_value": "2596.81", "confidence": 0.97, "flags": []},
    {"path": "line_items[4].date", "kind": "date", "extracted_value": "2026-09-07", "confidence": 0.97, "flags": []},
    {"path": "line_items[4].description", "kind": "text", "extracted_value": "Direct debit Brightwater Power", "confidence": 0.98, "flags": []},
    {"path": "line_items[4].reference", "kind": "text", "extracted_value": "DD-BWP-4471", "confidence": 0.98, "flags": []},
    {"path": "line_items[4].amount", "kind": "amount", "extracted_value": "-112.40", "confidence": 0.97, "flags": []},
    {"path": "line_items[4].balance", "kind": "amount", "extracted_value": "2484.41", "confidence": 0.97, "flags": []},
    {"path": "line_items[5].date", "kind": "date", "extracted_value": "2026-09-08", "confidence": 0.97, "flags": []},
    {"path": "line_items[5].description", "kind": "text", "extracted_value": "Client payment Quillford Theatre Trust", "confidence": 0.98, "flags": []},
    {"path": "line_items[5].reference", "kind": "text", "extracted_value": "INV-CDS-0088", "confidence": 0.98, "flags": []},
    {"path": "line_items[5].amount", "kind": "amount", "extracted_value": "640.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[5].balance", "kind": "amount", "extracted_value": "3124.41", "confidence": 0.97, "flags": []},
    {"path": "line_items[6].date", "kind": "date", "extracted_value": "2026-09-10", "confidence": 0.97, "flags": []},
    {"path": "line_items[6].description", "kind": "text", "extracted_value": "Transfer to savings", "confidence": 0.98, "flags": []},
    {"path": "line_items[6].reference", "kind": "text", "extracted_value": "TRF-0910", "confidence": 0.98, "flags": []},
    {"path": "line_items[6].amount", "kind": "amount", "extracted_value": "-300.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[6].balance", "kind": "amount", "extracted_value": "2824.41", "confidence": 0.97, "flags": []},
    {"path": "line_items[7].date", "kind": "date", "extracted_value": "2026-09-11", "confidence": 0.97, "flags": []},
    {"path": "line_items[7].description", "kind": "text", "extracted_value": "Card payment Pebble Market Hardware", "confidence": 0.98, "flags": []},
    {"path": "line_items[7].reference", "kind": "text", "extracted_value": "CP-0911-03", "confidence": 0.98, "flags": []},
    {"path": "line_items[7].amount", "kind": "amount", "extracted_value": "-46.75", "confidence": 0.97, "flags": []},
    {"path": "line_items[7].balance", "kind": "amount", "extracted_value": "2777.66", "confidence": 0.97, "flags": []},
    {"path": "line_items[8].date", "kind": "date", "extracted_value": "2026-09-12", "confidence": 0.97, "flags": []},
    {"path": "line_items[8].description", "kind": "text", "extracted_value": "Direct debit Examplia Telecom", "confidence": 0.98, "flags": []},
    {"path": "line_items[8].reference", "kind": "text", "extracted_value": "DD-EXT-2209", "confidence": 0.98, "flags": []},
    {"path": "line_items[8].amount", "kind": "amount", "extracted_value": "-39.90", "confidence": 0.97, "flags": []},
    {"path": "line_items[8].balance", "kind": "amount", "extracted_value": "2737.76", "confidence": 0.97, "flags": []},
    {"path": "line_items[9].date", "kind": "date", "extracted_value": "2026-09-14", "confidence": 0.97, "flags": []},
    {"path": "line_items[9].description", "kind": "text", "extracted_value": "Client payment Lanternfish Books", "confidence": 0.98, "flags": []},
    {"path": "line_items[9].reference", "kind": "text", "extracted_value": "INV-CDS-0089", "confidence": 0.98, "flags": []},
    {"path": "line_items[9].amount", "kind": "amount", "extracted_value": "415.50", "confidence": 0.97, "flags": []},
    {"path": "line_items[9].balance", "kind": "amount", "extracted_value": "3153.26", "confidence": 0.97, "flags": []},
    {"path": "line_items[10].date", "kind": "date", "extracted_value": "2026-09-15", "confidence": 0.97, "flags": []},
    {"path": "line_items[10].description", "kind": "text", "extracted_value": "Card payment Inkwell Lane Printers", "confidence": 0.98, "flags": []},
    {"path": "line_items[10].reference", "kind": "text", "extracted_value": "CP-0915-41", "confidence": 0.98, "flags": []},
    {"path": "line_items[10].amount", "kind": "amount", "extracted_value": "-128.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[10].balance", "kind": "amount", "extracted_value": "3025.26", "confidence": 0.97, "flags": []},
    {"path": "line_items[11].date", "kind": "date", "extracted_value": "2026-09-16", "confidence": 0.97, "flags": []},
    {"path": "line_items[11].description", "kind": "text", "extracted_value": "Subscription Sketchloom Software", "confidence": 0.98, "flags": []},
    {"path": "line_items[11].reference", "kind": "text", "extracted_value": "SUB-SKL-09", "confidence": 0.98, "flags": []},
    {"path": "line_items[11].amount", "kind": "amount", "extracted_value": "-24.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[11].balance", "kind": "amount", "extracted_value": "3001.26", "confidence": 0.97, "flags": []},
    {"path": "line_items[12].date", "kind": "date", "extracted_value": "2026-09-18", "confidence": 0.97, "flags": []},
    {"path": "line_items[12].description", "kind": "text", "extracted_value": "Card payment Copper Kettle Deli", "confidence": 0.98, "flags": []},
    {"path": "line_items[12].reference", "kind": "text", "extracted_value": "CP-0918-08", "confidence": 0.98, "flags": []},
    {"path": "line_items[12].amount", "kind": "amount", "extracted_value": "-12.60", "confidence": 0.97, "flags": []},
    {"path": "line_items[12].balance", "kind": "amount", "extracted_value": "2988.66", "confidence": 0.97, "flags": []},
    {"path": "line_items[13].date", "kind": "date", "extracted_value": "2026-09-19", "confidence": 0.97, "flags": []},
    {"path": "line_items[13].description", "kind": "text", "extracted_value": "Client payment Saltmere Rowing Club", "confidence": 0.98, "flags": []},
    {"path": "line_items[13].reference", "kind": "text", "extracted_value": "INV-CDS-0090", "confidence": 0.98, "flags": []},
    {"path": "line_items[13].amount", "kind": "amount", "extracted_value": "300.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[13].balance", "kind": "amount", "extracted_value": "3288.66", "confidence": 0.97, "flags": []},
    {"path": "line_items[14].date", "kind": "date", "extracted_value": "2026-09-21", "confidence": 0.97, "flags": []},
    {"path": "line_items[14].description", "kind": "text", "extracted_value": "Direct debit Brightwater Insurance", "confidence": 0.98, "flags": []},
    {"path": "line_items[14].reference", "kind": "text", "extracted_value": "DD-BWI-1180", "confidence": 0.98, "flags": []},
    {"path": "line_items[14].amount", "kind": "amount", "extracted_value": "-67.25", "confidence": 0.97, "flags": []},
    {"path": "line_items[14].balance", "kind": "amount", "extracted_value": "3221.41", "confidence": 0.97, "flags": []},
    {"path": "line_items[15].date", "kind": "date", "extracted_value": "2026-09-22", "confidence": 0.97, "flags": []},
    {"path": "line_items[15].description", "kind": "text", "extracted_value": "Card payment Bramblewood Paper Goods", "confidence": 0.98, "flags": []},
    {"path": "line_items[15].reference", "kind": "text", "extracted_value": "CP-0922-19", "confidence": 0.98, "flags": []},
    {"path": "line_items[15].amount", "kind": "amount", "extracted_value": "-53.10", "confidence": 0.97, "flags": []},
    {"path": "line_items[15].balance", "kind": "amount", "extracted_value": "3168.31", "confidence": 0.97, "flags": []},
    {"path": "line_items[16].date", "kind": "date", "extracted_value": "2026-09-24", "confidence": 0.97, "flags": []},
    {"path": "line_items[16].description", "kind": "text", "extracted_value": "Client payment Mossgate Bakery", "confidence": 0.98, "flags": []},
    {"path": "line_items[16].reference", "kind": "text", "extracted_value": "INV-CDS-0091", "confidence": 0.98, "flags": []},
    {"path": "line_items[16].amount", "kind": "amount", "extracted_value": "780.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[16].balance", "kind": "amount", "extracted_value": "3948.31", "confidence": 0.97, "flags": []},
    {"path": "line_items[17].date", "kind": "date", "extracted_value": "2026-09-25", "confidence": 0.97, "flags": []},
    {"path": "line_items[17].description", "kind": "text", "extracted_value": "Payroll September", "confidence": 0.98, "flags": []},
    {"path": "line_items[17].reference", "kind": "text", "extracted_value": "PAY-SEP-01", "confidence": 0.98, "flags": []},
    {"path": "line_items[17].amount", "kind": "amount", "extracted_value": "-1650.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[17].balance", "kind": "amount", "extracted_value": "2298.31", "confidence": 0.97, "flags": []},
    {"path": "line_items[18].date", "kind": "date", "extracted_value": "2026-09-26", "confidence": 0.97, "flags": []},
    {"path": "line_items[18].description", "kind": "text", "extracted_value": "Card payment Harbour Row Parking", "confidence": 0.98, "flags": []},
    {"path": "line_items[18].reference", "kind": "text", "extracted_value": "CP-0926-02", "confidence": 0.98, "flags": []},
    {"path": "line_items[18].amount", "kind": "amount", "extracted_value": "-9.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[18].balance", "kind": "amount", "extracted_value": "2289.31", "confidence": 0.97, "flags": []},
    {"path": "line_items[19].date", "kind": "date", "extracted_value": "2026-09-28", "confidence": 0.97, "flags": []},
    {"path": "line_items[19].description", "kind": "text", "extracted_value": "Account fee September", "confidence": 0.98, "flags": []},
    {"path": "line_items[19].reference", "kind": "text", "extracted_value": "FEE-0928", "confidence": 0.98, "flags": []},
    {"path": "line_items[19].amount", "kind": "amount", "extracted_value": "-6.50", "confidence": 0.97, "flags": []},
    {"path": "line_items[19].balance", "kind": "amount", "extracted_value": "2282.81", "confidence": 0.97, "flags": []},
    {"path": "line_items[20].date", "kind": "date", "extracted_value": "2026-09-29", "confidence": 0.97, "flags": []},
    {"path": "line_items[20].description", "kind": "text", "extracted_value": "Client payment Quillford Theatre Trust", "confidence": 0.98, "flags": []},
    {"path": "line_items[20].reference", "kind": "text", "extracted_value": "INV-CDS-0092", "confidence": 0.98, "flags": []},
    {"path": "line_items[20].amount", "kind": "amount", "extracted_value": "225.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[20].balance", "kind": "amount", "extracted_value": "2507.81", "confidence": 0.97, "flags": []},
    {"path": "line_items[21].date", "kind": "date", "extracted_value": "2026-09-30", "confidence": 0.97, "flags": []},
    {"path": "line_items[21].description", "kind": "text", "extracted_value": "Interest", "confidence": 0.98, "flags": []},
    {"path": "line_items[21].reference", "kind": "text", "extracted_value": "INT-SEP", "confidence": 0.98, "flags": []},
    {"path": "line_items[21].amount", "kind": "amount", "extracted_value": "1.84", "confidence": 0.97, "flags": []},
    {"path": "line_items[21].balance", "kind": "amount", "extracted_value": "2509.65", "confidence": 0.97, "flags": []}
  ],
  "checks": [
    {"check_id": "A1", "status": "pass", "field_paths": ["opening_balance","line_items[0].amount","line_items[1].amount","line_items[2].amount","line_items[3].amount","line_items[4].amount","line_items[5].amount","line_items[6].amount","line_items[7].amount","line_items[8].amount","line_items[9].amount","line_items[10].amount","line_items[11].amount","line_items[12].amount","line_items[13].amount","line_items[14].amount","line_items[15].amount","line_items[16].amount","line_items[17].amount","line_items[18].amount","line_items[19].amount","line_items[20].amount","line_items[21].amount","closing_balance"], "message": null},
    {"check_id": "A2", "status": "pass", "field_paths": ["line_items[0].amount","line_items[0].balance","line_items[1].amount","line_items[1].balance","line_items[2].amount","line_items[2].balance","line_items[3].amount","line_items[3].balance","line_items[4].amount","line_items[4].balance","line_items[5].amount","line_items[5].balance","line_items[6].amount","line_items[6].balance","line_items[7].amount","line_items[7].balance","line_items[8].amount","line_items[8].balance","line_items[9].amount","line_items[9].balance","line_items[10].amount","line_items[10].balance","line_items[11].amount","line_items[11].balance","line_items[12].amount","line_items[12].balance","line_items[13].amount","line_items[13].balance","line_items[14].amount","line_items[14].balance","line_items[15].amount","line_items[15].balance","line_items[16].amount","line_items[16].balance","line_items[17].amount","line_items[17].balance","line_items[18].amount","line_items[18].balance","line_items[19].amount","line_items[19].balance","line_items[20].amount","line_items[20].balance","line_items[21].amount","line_items[21].balance"], "message": null},
    {"check_id": "A3", "status": "pass", "field_paths": ["line_items[0].amount","line_items[1].amount","line_items[2].amount","line_items[3].amount","line_items[4].amount","line_items[5].amount","line_items[6].amount","line_items[7].amount","line_items[8].amount","line_items[9].amount","line_items[10].amount","line_items[11].amount","line_items[12].amount","line_items[13].amount","line_items[14].amount","line_items[15].amount","line_items[16].amount","line_items[17].amount","line_items[18].amount","line_items[19].amount","line_items[20].amount","line_items[21].amount","total_credits","total_debits"], "message": null},
    {"check_id": "D1", "status": "pass", "field_paths": ["statement_period_start","statement_period_end"], "message": null},
    {"check_id": "D2", "status": "pass", "field_paths": ["line_items[0].date","line_items[1].date","line_items[2].date","line_items[3].date","line_items[4].date","line_items[5].date","line_items[6].date","line_items[7].date","line_items[8].date","line_items[9].date","line_items[10].date","line_items[11].date","line_items[12].date","line_items[13].date","line_items[14].date","line_items[15].date","line_items[16].date","line_items[17].date","line_items[18].date","line_items[19].date","line_items[20].date","line_items[21].date","statement_period_start","statement_period_end"], "message": null},
    {"check_id": "U1", "status": "pass", "field_paths": ["bank_name","account_number_last4","statement_period_start","statement_period_end"], "message": null}
  ]
}
$result$::jsonb),

-- 5. purchase-order.pdf
('purchase-order', 'purchase_order', 'Purchase order for office furniture',
 'Every check passes: lines, shipping and tax add up to the total.',
 'purchase-order.pdf', 1, 5, true, $result$
{
  "doc_type": "purchase_order",
  "amount_tolerance": "0.01",
  "fields": [
    {"path": "language", "kind": "text", "extracted_value": "en", "confidence": 0.99, "flags": []},
    {"path": "currency", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "currency_as_printed", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "buyer_name", "kind": "text", "extracted_value": "Copperfinch Design Studio", "confidence": 0.98, "flags": []},
    {"path": "buyer_address", "kind": "text", "extracted_value": "Unit 3, 88 Harbour Row, Saltmere SM4 9ZZ, Examplia", "confidence": 0.98, "flags": []},
    {"path": "supplier_name", "kind": "text", "extracted_value": "Lanternfish Furniture Works", "confidence": 0.98, "flags": []},
    {"path": "supplier_address", "kind": "text", "extracted_value": "17 Kiln Yard, Mossgate MG2 7QT, Examplia", "confidence": 0.98, "flags": []},
    {"path": "ship_to_address", "kind": "text", "extracted_value": "Unit 3, 88 Harbour Row, Saltmere SM4 9ZZ, Examplia", "confidence": 0.98, "flags": []},
    {"path": "po_number", "kind": "text", "extracted_value": "CDS-PO-311", "confidence": 0.98, "flags": []},
    {"path": "payment_terms", "kind": "text", "extracted_value": "Net 30", "confidence": 0.98, "flags": []},
    {"path": "order_date", "kind": "date", "extracted_value": "2026-09-02", "confidence": 0.97, "flags": []},
    {"path": "requested_delivery_date", "kind": "date", "extracted_value": "2026-09-16", "confidence": 0.97, "flags": []},
    {"path": "subtotal", "kind": "amount", "extracted_value": "1521.00", "confidence": 0.97, "flags": []},
    {"path": "tax_total", "kind": "amount", "extracted_value": "288.99", "confidence": 0.97, "flags": []},
    {"path": "shipping", "kind": "amount", "extracted_value": "45.00", "confidence": 0.97, "flags": []},
    {"path": "total", "kind": "amount", "extracted_value": "1854.99", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].item_code", "kind": "text", "extracted_value": "LFW-DSK-140", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].description", "kind": "text", "extracted_value": "Oak standing desk, 140 cm", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].quantity", "kind": "number", "extracted_value": "2", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].unit_price", "kind": "amount", "extracted_value": "389.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].amount", "kind": "amount", "extracted_value": "778.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].item_code", "kind": "text", "extracted_value": "LFW-CHR-02", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].description", "kind": "text", "extracted_value": "Task chair, charcoal", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].quantity", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].unit_price", "kind": "amount", "extracted_value": "149.50", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].amount", "kind": "amount", "extracted_value": "598.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].item_code", "kind": "text", "extracted_value": "LFW-LMP-07", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].description", "kind": "text", "extracted_value": "Desk lamp, brass", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].quantity", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].unit_price", "kind": "amount", "extracted_value": "36.25", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].amount", "kind": "amount", "extracted_value": "145.00", "confidence": 0.97, "flags": []}
  ],
  "checks": [
    {"check_id": "A1", "status": "pass", "field_paths": ["line_items[0].quantity","line_items[0].unit_price","line_items[0].amount","line_items[1].quantity","line_items[1].unit_price","line_items[1].amount","line_items[2].quantity","line_items[2].unit_price","line_items[2].amount"], "message": null},
    {"check_id": "A2", "status": "pass", "field_paths": ["line_items[0].amount","line_items[1].amount","line_items[2].amount","subtotal"], "message": null},
    {"check_id": "A3", "status": "pass", "field_paths": ["subtotal","shipping","tax_total","total"], "message": null},
    {"check_id": "D1", "status": "pass", "field_paths": ["order_date"], "message": null},
    {"check_id": "D2", "status": "pass", "field_paths": ["order_date","requested_delivery_date"], "message": null},
    {"check_id": "U1", "status": "pass", "field_paths": ["buyer_name","po_number"], "message": null}
  ]
}
$result$::jsonb),

-- 6. delivery-note.pdf
('delivery-note', 'delivery_note', 'Delivery note for that order',
 'Quantities delivered checked against quantities ordered and the total; no prices, so no currency.',
 'delivery-note.pdf', 1, 6, true, $result$
{
  "doc_type": "delivery_note",
  "amount_tolerance": "0.01",
  "fields": [
    {"path": "language", "kind": "text", "extracted_value": "en", "confidence": 0.99, "flags": []},
    {"path": "currency", "kind": "text", "extracted_value": null, "confidence": 0.9, "flags": []},
    {"path": "currency_as_printed", "kind": "text", "extracted_value": null, "confidence": 0.9, "flags": []},
    {"path": "supplier_name", "kind": "text", "extracted_value": "Lanternfish Furniture Works", "confidence": 0.98, "flags": []},
    {"path": "customer_name", "kind": "text", "extracted_value": "Copperfinch Design Studio", "confidence": 0.98, "flags": []},
    {"path": "ship_to_address", "kind": "text", "extracted_value": "Unit 3, 88 Harbour Row, Saltmere SM4 9ZZ, Examplia", "confidence": 0.98, "flags": []},
    {"path": "delivery_note_number", "kind": "text", "extracted_value": "LFW-DN-5520", "confidence": 0.98, "flags": []},
    {"path": "po_number", "kind": "text", "extracted_value": "CDS-PO-311", "confidence": 0.98, "flags": []},
    {"path": "carrier", "kind": "text", "extracted_value": "Kestrel Freight", "confidence": 0.98, "flags": []},
    {"path": "tracking_number", "kind": "text", "extracted_value": "KF-7741-0093-EX", "confidence": 0.98, "flags": []},
    {"path": "delivery_date", "kind": "date", "extracted_value": "2026-09-15", "confidence": 0.97, "flags": []},
    {"path": "total_packages", "kind": "number", "extracted_value": "6", "confidence": 0.97, "flags": []},
    {"path": "total_quantity", "kind": "number", "extracted_value": "10", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].item_code", "kind": "text", "extracted_value": "LFW-DSK-140", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].description", "kind": "text", "extracted_value": "Oak standing desk, 140 cm", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].quantity_ordered", "kind": "number", "extracted_value": "2", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].quantity_delivered", "kind": "number", "extracted_value": "2", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].item_code", "kind": "text", "extracted_value": "LFW-CHR-02", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].description", "kind": "text", "extracted_value": "Task chair, charcoal", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].quantity_ordered", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].quantity_delivered", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].item_code", "kind": "text", "extracted_value": "LFW-LMP-07", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].description", "kind": "text", "extracted_value": "Desk lamp, brass", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].quantity_ordered", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].quantity_delivered", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []}
  ],
  "checks": [
    {"check_id": "A1", "status": "pass", "field_paths": ["line_items[0].quantity_delivered","line_items[1].quantity_delivered","line_items[2].quantity_delivered","total_quantity"], "message": null},
    {"check_id": "A2", "status": "pass", "field_paths": ["line_items[0].quantity_ordered","line_items[0].quantity_delivered","line_items[1].quantity_ordered","line_items[1].quantity_delivered","line_items[2].quantity_ordered","line_items[2].quantity_delivered"], "message": null},
    {"check_id": "D1", "status": "pass", "field_paths": ["delivery_date"], "message": null},
    {"check_id": "U1", "status": "pass", "field_paths": ["supplier_name","delivery_note_number"], "message": null}
  ]
}
$result$::jsonb),

-- 7. quote-date-error.pdf
('quote-date-error', 'quote', 'Quote with a date error',
 'A date flag: the quote is valid until a date a month before it was written.',
 'quote-date-error.pdf', 1, 7, true, $result$
{
  "doc_type": "quote",
  "amount_tolerance": "0.01",
  "fields": [
    {"path": "language", "kind": "text", "extracted_value": "en", "confidence": 0.99, "flags": []},
    {"path": "currency", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "currency_as_printed", "kind": "text", "extracted_value": "EUR", "confidence": 0.98, "flags": []},
    {"path": "supplier_name", "kind": "text", "extracted_value": "Saltmere Signworks", "confidence": 0.98, "flags": []},
    {"path": "supplier_address", "kind": "text", "extracted_value": "2 Ropewalk Quay, Saltmere SM1 4LP, Examplia", "confidence": 0.98, "flags": []},
    {"path": "customer_name", "kind": "text", "extracted_value": "Copperfinch Design Studio", "confidence": 0.98, "flags": []},
    {"path": "customer_address", "kind": "text", "extracted_value": "Unit 3, 88 Harbour Row, Saltmere SM4 9ZZ, Examplia", "confidence": 0.98, "flags": []},
    {"path": "quote_number", "kind": "text", "extracted_value": "SSW-Q-2026-058", "confidence": 0.98, "flags": []},
    {"path": "payment_terms", "kind": "text", "extracted_value": "50% on order, balance on installation", "confidence": 0.98, "flags": []},
    {"path": "quote_date", "kind": "date", "extracted_value": "2026-10-05", "confidence": 0.97, "flags": ["check_failed"]},
    {"path": "valid_until", "kind": "date", "extracted_value": "2026-09-05", "confidence": 0.97, "flags": ["check_failed"]},
    {"path": "subtotal", "kind": "amount", "extracted_value": "1026.00", "confidence": 0.97, "flags": []},
    {"path": "discount_total", "kind": "amount", "extracted_value": "51.30", "confidence": 0.97, "flags": []},
    {"path": "tax_total", "kind": "amount", "extracted_value": "185.19", "confidence": 0.97, "flags": []},
    {"path": "total", "kind": "amount", "extracted_value": "1159.89", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].description", "kind": "text", "extracted_value": "Shopfront sign, painted aluminium, 240 x 60 cm", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].item_code", "kind": "text", "extracted_value": "SSW-SF-240", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].quantity", "kind": "number", "extracted_value": "1", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].unit", "kind": "text", "extracted_value": "pcs", "confidence": 0.98, "flags": []},
    {"path": "line_items[0].unit_price", "kind": "amount", "extracted_value": "680.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[0].amount", "kind": "amount", "extracted_value": "680.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].description", "kind": "text", "extracted_value": "Window vinyl lettering", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].item_code", "kind": "text", "extracted_value": "SSW-VL-01", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].quantity", "kind": "number", "extracted_value": "3", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].unit", "kind": "text", "extracted_value": "sqm", "confidence": 0.98, "flags": []},
    {"path": "line_items[1].unit_price", "kind": "amount", "extracted_value": "42.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[1].amount", "kind": "amount", "extracted_value": "126.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].description", "kind": "text", "extracted_value": "Installation", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].item_code", "kind": "text", "extracted_value": null, "confidence": 0.9, "flags": []},
    {"path": "line_items[2].quantity", "kind": "number", "extracted_value": "4", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].unit", "kind": "text", "extracted_value": "h", "confidence": 0.98, "flags": []},
    {"path": "line_items[2].unit_price", "kind": "amount", "extracted_value": "55.00", "confidence": 0.97, "flags": []},
    {"path": "line_items[2].amount", "kind": "amount", "extracted_value": "220.00", "confidence": 0.97, "flags": []}
  ],
  "checks": [
    {"check_id": "A1", "status": "pass", "field_paths": ["line_items[0].quantity","line_items[0].unit_price","line_items[0].amount","line_items[1].quantity","line_items[1].unit_price","line_items[1].amount","line_items[2].quantity","line_items[2].unit_price","line_items[2].amount"], "message": null},
    {"check_id": "A2", "status": "pass", "field_paths": ["line_items[0].amount","line_items[1].amount","line_items[2].amount","subtotal"], "message": null},
    {"check_id": "A3", "status": "pass", "field_paths": ["subtotal","discount_total","tax_total","total"], "message": null},
    {"check_id": "D1", "status": "pass", "field_paths": ["quote_date"], "message": null},
    {"check_id": "D2", "status": "fail", "field_paths": ["quote_date","valid_until"], "message": "Valid until 2026-09-05 is before quote date 2026-10-05"},
    {"check_id": "U1", "status": "pass", "field_paths": ["supplier_name","quote_number"], "message": null}
  ]
}
$result$::jsonb);
