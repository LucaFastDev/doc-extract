# doc-extract: product requirements

Status: draft for the operator's review (issue #1). Nothing is built until this document and
[ARCHITECTURE.md](ARCHITECTURE.md) are approved.

Where this document has to state something the issue does not settle, the text says **Proposed**
and names an open question (**OQ-n**) from the last section. A proposed item is a starting point
for review, not a decided requirement; a worker must not build it until the operator confirms or
replaces it.

## 1. Problem and who it is for

Small businesses, bookkeepers and freelancers receive invoices, receipts, bank statements,
purchase orders, delivery notes and quotes as PDFs, phone photos and scans. Getting the numbers
out of them into a spreadsheet or bookkeeping tool means retyping, and retyping produces errors
that nobody notices until the books do not balance.

doc-extract reads each document with Claude and returns structured data: header fields, line
items and a confidence for every field. It then **checks** the result (arithmetic, dates,
duplicates) and puts anything doubtful in front of a person first. A person approves the result,
and approved results export to CSV or XLSX.

Audiences:

- **Users**: a person who processes business documents for themselves or a small team, and wants
  checked data out without retyping. They work in English in the app, but their documents can be
  in any language and any currency.
- **Visitors**: someone who reaches the site from the operator's portfolio. They must see the
  product working in one click, without signing up and without the app spending money on AI.
- **The operator**: runs the deployed app on a hard AI budget of $10 a month and uses the repo as
  portfolio evidence. The repo is built by unattended agents from this document and
  ARCHITECTURE.md, so every requirement here must be testable.

## 2. Feature summary

| Id | Feature |
|---|---|
| F1 | Upload a document (PDF, photo or scan) |
| F2 | Extraction with Claude: fields, line items, per-field confidence |
| F3 | Six document types, each with its own field set and checks |
| F4 | Checks: arithmetic, date sanity, duplicate detection; a failed check flags fields |
| F5 | Review screen: document beside fields, flagged first; correct and approve |
| F6 | Export approved results as CSV and XLSX |
| F7 | English UI; documents in any language; amounts in the printed currency |
| F8 | Workspaces with member invites; roles owner and member |
| F9 | Sign-in with email and with Google |
| F10 | Live processing status |
| F11 | Billing in Stripe test mode: Free 20 pages a month, Pro 500 pages a month |
| F12 | Hard AI spend cap of $10 a month for the deployed app |
| F13 | Public one-click demo with stored results; own uploads need an account, capped at 10 pages |
| F14 | Uploaded files are deleted after 7 days |
| F15 | Landing page |
| F16 | Eval set with measured field accuracy per document type |
| F17 | A clean look defined on shadcn/ui, adjustable later |

## 3. User stories and acceptance criteria

Each criterion is written to be checked by a unit test, an access test or an end-to-end test in
which Claude is mocked. "The user" is a signed-in member of the current workspace unless a story
says otherwise.

### F1. Upload

**US-1.1** As a user, I want to upload a PDF, a photo or a scan of a business document, so that it
gets read without my retyping it.

- AC-1: The upload control accepts PDF files and image files of the formats listed in OQ-4, by
  file picker and by drag and drop.
- AC-2: A file of any other type is refused before upload with a message naming the accepted
  types, and no document is created.
- AC-3: A file over the size limit (OQ-4) is refused before upload with a message naming the limit.
- AC-4: After a successful upload the document appears in the workspace's document list with
  status "Queued" and its page count.
- AC-5: An upload that would take the workspace over its page allowance (F11, F13) is refused
  with a message saying how many pages remain, and no pages are counted.
- AC-6: **Proposed** (**OQ-23**): while the AI spend cap is reached (F12), a new upload is refused
  with the spend cap message, and no pages are counted.
- AC-7: **Proposed** (**OQ-42**): a user can upload several files in one action; each becomes its
  own document.

**US-1.2** As a user, I want to know which document type a file is, so that the right fields
are extracted. Who chooses the type, the user at upload or Claude, is **OQ-1**.

- AC-1: Every document has exactly one of the six types before its fields are shown.
- AC-2: The type is shown on the document list and the review screen.

### F2. Extraction

**US-2.1** As a user, I want Claude to read my document and return its fields and line items, so
that I do not type them.

- AC-1: For each document, the result holds every field of its type's field set (section 4); a
  field not present on the document is stored as empty, not invented.
- AC-2: Line items (or transactions, for bank statements) are returned in the order printed.
- AC-3: Every field and every line-item cell has a confidence between 0 and 1.
- AC-4: A field whose confidence is below the threshold (OQ-8) is flagged "Low confidence".
- AC-5: Dates are stored in ISO 8601 (YYYY-MM-DD); amounts as exact decimals, with no rounding
  beyond what is printed.
- AC-6: If extraction fails after its retries, the document has status "Failed" with a reason the
  user can read. **Proposed** (**OQ-10**): the user can retry it. Whether the failed attempt's
  pages count against the allowance is also **OQ-10**.
- AC-7: A multi-page document is extracted as one document. Whether one file may hold several
  documents (for example a PDF of ten invoices) is **OQ-5**; until it is settled, one file is one
  document.

### F3 and F4. Document types and checks

**US-3.1** As a user, I want each type to have the fields that matter for it, so that the output
fits how I use it. The field sets are in section 4.

- AC-1: Each of the six types has a field set, a line-item set and a list of checks, defined once
  and used by extraction, review, checks and export.

**US-4.1** As a user, I want the result checked, so that a misread number does not slip through.

- AC-1: Every check listed for a type in section 4 runs on every extraction of that type.
- AC-2: A check that fails flags each field it names, with a reason that says what did not add up
  (for example "Line items sum to 1,180.00; subtotal is 1,200.00").
- AC-3: **Proposed** (**OQ-43**): a check whose inputs are empty (for example no tax printed) is
  recorded as "Skipped", not as passed or failed.
- AC-4: Arithmetic checks compare amounts with a tolerance (**OQ-7**) in the document's currency.
- AC-5: Date sanity checks follow the rules in section 4.2 (**OQ-6** for the exact rules).
- AC-6: Duplicate detection flags a document that matches an earlier document in the same
  workspace by the rule in section 4.3 (**OQ-9**), and links to the earlier one.
- AC-7: **Proposed** (**OQ-44**): when the user corrects a field on the review screen, the checks
  that use it are re-evaluated and the flags update without a page reload.

### F5. Review

**US-5.1** As a user, I want to see the document beside the extracted fields, flagged fields
first, so that I check what is doubtful before the rest.

- AC-1: The review screen shows the original document beside the fields. **Proposed**
  (**OQ-44**): all pages are shown, and the document can be zoomed.
- AC-2: Flagged fields (failed check, low confidence, duplicate) are listed before unflagged
  fields, each with its reason.
- AC-3: Each field shows its confidence.
- AC-4: The user can edit any field and any line-item cell. **Proposed** (**OQ-44**): the user can
  also add a missing line item and delete a wrong one, and the original extracted value stays
  visible next to a corrected one.
- AC-5: The user can approve the document; it then has status "Approved". **Proposed**
  (**OQ-44**): who approved it and when is recorded and shown.
- AC-6: Whether a document can be approved while a check still fails is **OQ-11**. Whether an
  approved document can be reopened is **OQ-12**.
- AC-7: After the file is deleted (F14), the review screen shows the fields and says the file was
  deleted after 7 days (subject to **OQ-14**).

### F6. Export

**US-6.1** As a user, I want to export approved results as CSV and XLSX, so that I can bring them
into a spreadsheet or another tool.

- AC-1: Only approved documents can be exported.
- AC-2: An export contains the corrected value where there is one, and the extracted value
  otherwise.
- AC-3: **Proposed** (**OQ-13**): CSV is UTF-8 with a header row, RFC 4180 quoting, and amounts
  as plain decimals without thousands separators, with the currency in its own column.
- AC-4: **Proposed** (**OQ-13**): XLSX holds the same data, with amounts as numbers and dates as
  dates.
- AC-5: How documents are selected for one export, and how header fields and line items are laid
  out (one file per type, one row per line item, one sheet per type) is **OQ-13**.
- AC-6: QuickBooks, Xero or any other accounting integration is not offered (section 9).

### F7. Language and currency

**US-7.1** As a user with documents in other languages and currencies, I want them read as they
are, so that my figures stay correct.

- AC-1: Every screen, message and email of the app is in English.
- AC-2: A document in any language is accepted and extracted; text fields keep the language as
  printed (whether to translate is **OQ-15**; until settled, no translation).
- AC-3: Amounts are kept in the currency printed on the document; nothing is converted.
- AC-4: Each document records its currency as an ISO 4217 code and as printed. When the printed
  symbol is ambiguous (for example "$"), handling is **OQ-16**.

### F8. Workspaces, invites and roles

**US-8.1** As a new user, I want a workspace, so that my documents are kept apart from everyone
else's.

- AC-1: A user can see documents, fields and exports only of workspaces they are a member of;
  this is enforced by the database, not only by the UI.
- AC-2: Whether a workspace is created automatically at first sign-in, and whether a user can
  belong to several workspaces, is **OQ-17**.

**US-8.2** As a workspace owner, I want to invite people by email, so that we can share the work.

- AC-1: **Proposed** (**OQ-20**): an owner can invite an email address as owner or member.
- AC-2: **Proposed** (**OQ-18**): the invitee who signs in with that email address and accepts
  becomes a member with the invited role; nobody else can accept the invitation.
- AC-3: **Proposed** (**OQ-18**): an invitation can be accepted once, and expires after a time set
  in **OQ-18**.
- AC-4: **Proposed** (**OQ-20**): an owner can revoke a pending invitation and remove a member.
- AC-5: **Proposed** (**OQ-20**): a workspace always has at least one owner: removing or demoting
  the last owner is refused.
- AC-6: **Proposed** (**OQ-20**): a member cannot invite, remove members or change roles.
- AC-7: How the invitation reaches the invitee (an email, which needs an email provider, or a link
  the owner copies) is **OQ-19**.
- AC-8: What a member can do besides upload, review, approve and export (for example billing, or
  deleting documents) is **OQ-20**. **Proposed:** owners manage members, invitations and billing;
  members and owners both upload, review, approve and export.

### F9. Sign-in

**US-9.1** As a user, I want to sign in with my email or my Google account.

- AC-1: A user can sign in with email (method in **OQ-21**: magic link, password, or both).
- AC-2: A user can sign in with Google.
- AC-3: **Proposed** (**OQ-34**): signing in with Google and with email for the same address
  gives the same account.
- AC-4: Signing out ends the session; a signed-out visitor who opens an app page is sent to
  sign-in. **Proposed** (**OQ-34**): after signing in, they are sent back to that page.

### F10. Live status

**US-10.1** As a user, I want to see each document's processing status change as it happens, so
that I do not reload the page.

- AC-1: The statuses are: Queued, Processing, Needs review, Approved, Failed, and Waiting for
  budget if queued documents wait while the spend cap is reached (**OQ-23**).
- AC-2: A status change made on the server appears on every open document list and review screen
  of that workspace without a reload. **Proposed** (**OQ-35**): within 5 seconds.
- AC-3: A user never receives status updates for another workspace's documents.

### F11. Billing (Stripe test mode)

**US-11.1** As an owner, I want to move the workspace to Pro, so that we get more pages.

- AC-1: The billing page shows the current plan, pages used this period and pages left.
- AC-2: Free allows 20 pages a month; Pro allows 500 pages a month. How these relate to the
  10-page account cap (F13) is **OQ-2**; how plan limits apply (per workspace or per account) is
  **OQ-3**.
- AC-3: Upgrading opens Stripe Checkout **in test mode**; completing it with a Stripe test card
  makes the workspace Pro. **Proposed** (**OQ-36**): within 10 seconds of Stripe's webhook.
- AC-4: The app never creates a real charge: the server refuses to start if its Stripe key is a
  live key.
- AC-5: **Proposed** (**OQ-45**): the page says plainly that billing is a test-mode demonstration
  and that test cards only are accepted.
- AC-6: **Proposed** (**OQ-37**): cancelling (through Stripe's customer portal) returns the
  workspace to Free at the end of the paid period.
- AC-7: The Pro price shown in test mode, the period the allowance resets on (calendar month or
  billing period), and what happens to a downgrade mid-period are **OQ-24**.

### F12. AI spend cap

**US-12.1** As the operator, I want AI spending to stop at $10 a month, so that the deployed demo
can never cost me more.

- AC-1: The app's total Claude spend in a month never exceeds $10, enforced on the server before
  each Claude call, using an upper-bound estimate so that concurrent calls cannot pass the cap
  together.
- AC-2: When the next extraction would pass the cap, no Claude call is made, and every user who
  uploads or retries sees: "Extraction is paused: this demo has reached its monthly AI budget. It
  resumes on <date>." (wording adjustable).
- AC-3: Signing in, reviewing, approving, exporting and the public demo keep working while the cap
  is reached.
- AC-4: The month the cap resets on is **OQ-22**. **Proposed:** calendar month, UTC.
- AC-5: The cap amount is configuration, not code, so the operator can change it without a
  release.
- AC-6: The provider's own monthly limit for the API key is also set to $10 (docs/go-live.md), so
  a fault in the app's accounting cannot spend more.

### F13. Public demo

**US-13.1** As a visitor, I want to try the product in one click without signing up.

- AC-1: The landing page has one button that opens the demo, with no sign-up and no sign-in.
- AC-2: The demo offers fixed sample documents, at least one of each of the six types.
- AC-3: Opening a sample shows its stored result on the review screen: document, fields, line
  items, confidences, checks and flags. **Proposed** (**OQ-38**): at least one sample has a failed
  check.
- AC-4: The demo never calls Claude: opening every sample leaves the app's AI spend unchanged.
- AC-5: What a visitor can do on a sample (edit fields, approve, export) and whether anything
  they do is kept is **OQ-25**. **Proposed:** edits and export work in the browser only, nothing
  is saved, and a reload restores the stored result.
- AC-6: The demo offers sign-up for uploading one's own documents.

**US-13.2** As a visitor who signs up, I want to upload my own documents.

- AC-1: Uploading needs an account.
- AC-2: An account can process at most 10 pages (period and relation to the plans: **OQ-2**).
- AC-3: The upload screen shows how many of the 10 pages are left (what the 10 pages are counted
  over: **OQ-2**).

### F14. Retention

**US-14.1** As a user, I want my uploaded files deleted after 7 days, so that my documents are not
kept longer than needed.

- AC-1: Every uploaded file is deleted from storage after it is 7 days old (measured from upload;
  **OQ-14** for whether extracted data is deleted too, and whether the clock starts at upload or
  approval). **Proposed** (**OQ-39**): within 24 hours after it is 7 days old.
- AC-2: Deletion runs on a schedule with no person involved, and a failed deletion is retried on
  the next run.
- AC-3: The demo's sample files are not deleted.
- AC-4: **Proposed** (**OQ-45**): the landing page and the upload screen say that files are
  deleted after 7 days.

### F15. Landing page

**US-15.1** As a visitor, I want to understand in a few seconds what the product does.

- AC-1: A public landing page at `/` shows the demo button (F13). **Proposed** (**OQ-27**): it
  also says what doc-extract does, lists the six document types and shows a sign-up button.
- AC-2: **Proposed** (**OQ-27**): it shows the measured accuracy per document type from the latest
  eval run (F16), with the date of that run and the model used.
- AC-3: **Proposed** (**OQ-45**): it states the 7-day file deletion and that billing is in test
  mode.
- AC-4: Its further content (copy, sections, screenshots) is **OQ-27**.

### F16. Eval set

**US-16.1** As the operator, I want field accuracy measured per document type, so that I can show
how well it works and catch regressions when the prompt or model changes.

- AC-1: The repo holds an eval set: documents with hand-checked expected results, for each of the
  six types (size and sourcing: **OQ-26**).
- AC-2: One command runs the eval against the real Claude API and writes, per document type, the
  field accuracy defined in section 10.
- AC-3: The eval never runs in CI and never runs on its own; it runs only when the operator starts
  it (who pays for it: **OQ-26**).
- AC-4: **Proposed** (**OQ-26**): each run's results are saved in the repo with the date, the
  model and the prompt version.
- AC-5: The scoring (comparing a result to an expected result) has unit tests.

### F17. Look

**US-17.1** As the operator, I want a clean, consistent look I can adjust later.

- AC-1: Every colour, radius and font the app uses comes from design tokens (CSS variables) in
  `src/index.css`, as shadcn/ui lays them out, so the look changes in one place.
- AC-2: UI components come from shadcn/ui.
- AC-3: **Proposed** (**OQ-40**): the app works at phone width (360px) and desktop width; the
  review screen stacks the document above the fields at phone width.
- AC-4: **Proposed** (**OQ-41**): light theme is required; a dark theme is not in v1.

## 4. Document types: field sets and checks

**Proposed field sets and checks** (**OQ-28**). The issue fixes the six types, the three kinds of
check and three arithmetic checks (line items sum to subtotal, subtotal + tax = total, opening
balance + transactions = closing balance); the field lists and every other check below are this
PRD's proposal for the operator to confirm or change.

Every type also has these common fields: `language` (detected, BCP 47 code), `currency` (ISO 4217
code), `currency_as_printed`.

Field kinds: **text**, **date** (ISO 8601), **amount** (exact decimal in the document's
currency), **number** (exact decimal), **percent**.

### 4.1 Field sets

#### Invoice

| Field | Kind |
|---|---|
| vendor_name, vendor_address, vendor_tax_id | text |
| customer_name, customer_address, customer_tax_id | text |
| invoice_number, purchase_order_number, payment_terms | text |
| invoice_date, due_date | date |
| subtotal, tax_total, shipping, discount_total, total, amount_paid, amount_due | amount |

Line items: `description` (text), `item_code` (text), `quantity` (number), `unit` (text),
`unit_price` (amount), `tax_rate` (percent), `amount` (amount).

Checks:

- A1 each line: quantity × unit_price = amount
- A2 sum of line amounts = subtotal
- A3 subtotal − discount_total + shipping + tax_total = total
- A4 total − amount_paid = amount_due
- D1 invoice_date is not in the future
- D2 due_date ≥ invoice_date
- U1 duplicate: same vendor (normalised name or tax id) and invoice_number

#### Receipt

| Field | Kind |
|---|---|
| merchant_name, merchant_address, merchant_tax_id | text |
| receipt_number, payment_method, card_last4 | text |
| transaction_date | date |
| transaction_time | text (HH:MM) |
| subtotal, tax_total, tip, total | amount |

Line items: `description`, `quantity`, `unit_price`, `amount`.

Checks:

- A1 each line: quantity × unit_price = amount
- A2 sum of line amounts = subtotal
- A3 subtotal + tax_total + tip = total
- D1 transaction_date is not in the future
- U1 duplicate: same merchant, transaction_date, transaction_time and total

**Proposed** (**OQ-29**): `card_last4` holds at most four digits; anything longer read from the
document is cut to its last four.

#### Bank statement

| Field | Kind |
|---|---|
| bank_name, account_holder, account_number_last4, iban_last4 | text |
| statement_period_start, statement_period_end | date |
| opening_balance, closing_balance, total_credits, total_debits | amount |

Transactions: `date` (date), `description` (text), `reference` (text), `amount` (amount, signed:
credits positive, debits negative), `balance` (amount, the running balance where printed).

Checks:

- A1 opening_balance + sum of transaction amounts = closing_balance
- A2 each transaction with a printed balance: previous balance + amount = balance
- A3 sum of positive amounts = total_credits, and sum of negative amounts = −total_debits, where
  printed
- D1 statement_period_end ≥ statement_period_start, and neither is in the future
- D2 every transaction date is within the statement period
- U1 duplicate: same account (bank name and last four digits) and same period

Full account numbers and IBANs are not stored, only their last four characters (**OQ-29**).

#### Purchase order

| Field | Kind |
|---|---|
| buyer_name, buyer_address, supplier_name, supplier_address, ship_to_address | text |
| po_number, payment_terms | text |
| order_date, requested_delivery_date | date |
| subtotal, tax_total, shipping, total | amount |

Line items: `item_code`, `description`, `quantity`, `unit`, `unit_price`, `amount`.

Checks:

- A1 each line: quantity × unit_price = amount
- A2 sum of line amounts = subtotal
- A3 subtotal + shipping + tax_total = total
- D1 order_date is not in the future
- D2 requested_delivery_date ≥ order_date
- U1 duplicate: same buyer and po_number

#### Delivery note

| Field | Kind |
|---|---|
| supplier_name, customer_name, ship_to_address | text |
| delivery_note_number, po_number, carrier, tracking_number | text |
| delivery_date | date |
| total_packages, total_quantity | number |

Line items: `item_code`, `description`, `quantity_ordered` (number), `quantity_delivered`
(number), `unit`.

Checks:

- A1 sum of quantity_delivered = total_quantity, where printed
- A2 each line: quantity_delivered ≤ quantity_ordered, where both are printed (a short or over
  delivery is flagged for review, not treated as a misread)
- D1 delivery_date is not in the future
- U1 duplicate: same supplier and delivery_note_number

A delivery note has no amounts, so `currency` may be empty.

#### Quote

| Field | Kind |
|---|---|
| supplier_name, supplier_address, customer_name, customer_address | text |
| quote_number, payment_terms | text |
| quote_date, valid_until | date |
| subtotal, discount_total, tax_total, total | amount |

Line items: `description`, `item_code`, `quantity`, `unit`, `unit_price`, `amount`.

Checks:

- A1 each line: quantity × unit_price = amount
- A2 sum of line amounts = subtotal
- A3 subtotal − discount_total + tax_total = total
- D1 quote_date is not in the future
- D2 valid_until ≥ quote_date
- U1 duplicate: same supplier and quote_number

### 4.2 Date sanity (all types)

**Proposed** (**OQ-6**): a date is flagged when it is in the future by more than one day
(allowing for time zones), when it comes before 2000-01-01, or when it breaks an ordering rule of
its type (D2 above). The 2000 floor and the one-day allowance are proposals.

### 4.3 Duplicate detection (all types)

**Proposed** (**OQ-9**): two documents are duplicates when, within the same workspace, either the
uploaded files are byte-identical (same SHA-256), or the type's U1 key matches after
normalisation (case, whitespace and punctuation removed from names and numbers). A duplicate is
flagged, not refused, and links to the earlier document. Whether the comparison has a time window
or includes documents whose files were deleted is part of OQ-9.

## 5. Plans, limits and the spend cap

| Limit | Value | Source |
|---|---|---|
| Free plan | 20 pages a month | issue |
| Pro plan | 500 pages a month | issue |
| Own uploads per account | capped at 10 pages | issue |
| AI spend, whole deployed app | $10 a month, hard stop | issue |
| Billing | Stripe test mode only, never real charges | issue |
| What a page is | one PDF page; one image file = one page | **Proposed**, OQ-2 |
| Period | calendar month, UTC | **Proposed**, OQ-22, OQ-24 |

The 20/500 plan limits and the 10-page account cap are both in the issue and do not say how they
combine (**OQ-2**); a worker must not pick one. The spend cap applies to the whole deployed app,
not to each workspace, and the demo does not count against it because it makes no Claude calls.

## 6. The demo

- One click from the landing page, no account.
- Fixed sample documents, at least one per type. **Proposed** (**OQ-38**): chosen so that the six
  together show every kind of flag: a failed arithmetic check, a date flag, a low-confidence field
  and a duplicate.
- **Results are hardcoded**: each sample's stored extraction result is shown; nothing is
  re-extracted per visitor and the demo never calls Claude.
- **Proposed** (**OQ-25**): the sample documents are fictitious, with no real person's or
  company's data. Who makes them, and how their stored results are produced (one real extraction
  run reviewed by the operator, or written by hand), is also **OQ-25**.
- Uploading one's own documents needs an account, capped at 10 pages per account (OQ-2).

## 7. Retention

- Uploaded files are deleted 7 days after upload by a scheduled job (F14; when the clock starts
  is **OQ-14**, how soon after the 7 days is **OQ-39**).
- Demo sample files are kept.
- What happens to extracted fields, check results and approvals after the file is deleted, and
  how long they are kept, is **OQ-14**.
- Deleting one's account or workspace, and its data, is **OQ-30**.

## 8. Non-functional requirements

- The Claude API key exists only on the server (Edge Functions); it never reaches the browser.
- Every table is protected by row level security; a user reaches only their workspaces' data.
- Every test and end-to-end run mocks Claude; CI never calls the Claude API and holds no key.
- A missing backend setting fails loudly at startup; nothing falls back to a production service.
- Stripe runs in test mode only; a live key is refused at startup.

## 9. Out of scope for v1

- QuickBooks, Xero or any other accounting integration; any export other than CSV and XLSX.
- Real payments; Stripe live mode.
- A UI language other than English; currency conversion.
- Re-extracting demo documents per visitor.
- Roles other than owner and member.
- Sign-in methods other than email and Google.
- Mobile apps, an email-in address, a public API or webhooks for customers (**OQ-31** if any are
  wanted).
- Unless the operator decides otherwise: several documents in one file (OQ-5), translation
  (OQ-15), dark theme (**Proposed**, OQ-41).

## 10. Success measures

**Field accuracy**, measured by the eval set (F16). **Proposed** definition (**OQ-32**): for a
document type, the share of expected
field values (header fields and line-item cells) that the extraction returns exactly, after
normalisation (dates as ISO 8601, amounts as decimals, text with case and surrounding whitespace
ignored). An empty expected value counts as correct only when the extraction is also empty.

**Proposed targets** (**OQ-32**):

| Type | Header fields | Line items / transactions |
|---|---|---|
| Invoice | ≥ 95% | ≥ 90% |
| Receipt | ≥ 92% | ≥ 85% |
| Bank statement | ≥ 95% | ≥ 95% |
| Purchase order | ≥ 95% | ≥ 90% |
| Delivery note | ≥ 95% | ≥ 90% |
| Quote | ≥ 95% | ≥ 90% |

Other measures:

- **Check usefulness** (**Proposed**, **OQ-32**): in the eval set, every seeded misread of a total
  or subtotal is flagged by an arithmetic check.
- **Demo**: a visitor reaches a sample's review screen in one click from the landing page.
- **Cost**: the deployed app's Claude spend stays at or under $10 in every month.

## Open questions

Each is a requirement the issue does not settle. Nothing marked **Proposed** above is built until
its question is answered.

1. **OQ-1 Document type selection.** Does the user pick the type at upload, does Claude detect it,
   or does Claude detect it and the user confirm or change it? What happens to a document that is
   none of the six types?
2. **OQ-2 Page limits.** The issue sets Free 20 pages a month, Pro 500 pages a month, and "capped
   at 10 pages per account" for own uploads. How do these combine: is 10 a lifetime cap for every
   account in the deployed demo that overrides the plans, a monthly cap, or the Free plan's limit
   in the deployed app? Does the cap apply to Pro workspaces? Is an image file one page?
3. **OQ-3 Plan scope.** Is the plan (and its page allowance) per workspace or per user account?
4. **OQ-4 Accepted files.** Which image formats (JPEG, PNG, HEIC, WebP, TIFF)? Maximum file size?
   Maximum pages per document?
5. **OQ-5 Several documents in one file.** Is a PDF holding several documents split, refused, or
   treated as one document?
6. **OQ-6 Date sanity rules.** Confirm or replace the proposal in section 4.2 (future dates, a
   floor date, ordering rules).
7. **OQ-7 Arithmetic tolerance.** What difference counts as equal: 0.01 in the document's
   currency, half the smallest printed unit, or something else?
8. **OQ-8 Confidence.** What confidence threshold flags a field? Is the model's own confidence
   acceptable as the per-field confidence, or must it be calibrated against the eval set?
9. **OQ-9 Duplicate rule.** Confirm or replace section 4.3: the matching keys per type, whether
   there is a time window, and whether documents whose files were deleted still count.
10. **OQ-10 Failed extractions and the allowance.** Can the user retry a document whose extraction
    failed (proposed in AC-6 of US-2.1: yes)? Do pages of a document whose extraction failed count
    against the page allowance? Does a user retry count again?
11. **OQ-11 Approving with failed checks.** Can a document be approved while a check fails or a
    field is flagged? If yes, must the user acknowledge each flag?
12. **OQ-12 Reopening.** Can an approved document be reopened and edited? Who can do it?
13. **OQ-13 Export layout and format.** Which documents go into one export (one document, a
    selection, all approved in a date range)? One file per type, or mixed types? Header fields and
    line items in one sheet (one row per line item, header repeated) or two sheets / two files?
    Confirm or replace the formats proposed in AC-3 and AC-4 of US-6.1: CSV in UTF-8 with a header
    row, RFC 4180 quoting, plain decimals without thousands separators and the currency in its own
    column; XLSX with amounts as numbers and dates as dates.
14. **OQ-14 Retention scope.** Are only the uploaded files deleted after 7 days, or also the
    extracted data? Does the clock start at upload or at approval? Is the 7 days the same on every
    plan?
15. **OQ-15 Translation.** Should text fields (descriptions, names) be kept as printed or also
    translated into English?
16. **OQ-16 Ambiguous currency.** When a symbol is ambiguous ("$", "kr"), does the extraction guess
    from context and flag the field, or ask the user?
17. **OQ-17 Workspace creation.** Is a personal workspace created automatically at first sign-in?
    Can a user belong to several workspaces and create more? Can a workspace be renamed or deleted?
18. **OQ-18 Invitation rules.** How long is an invitation valid? Confirm or replace the proposal in
    AC-2 and AC-3 of US-8.2: an invitation can be accepted only by someone signed in with the
    invited email address, and only once.
19. **OQ-19 Invitation and sign-in email.** Email sign-in and email invitations need an email
    provider in production (Supabase's built-in sender only reaches the project's own team and is
    heavily rate-limited). Which provider and sending domain? Or should invitations be a link the
    owner copies?
20. **OQ-20 Roles.** Confirm or replace the proposals in AC-1 and AC-4 to AC-8 of US-8.2: only
    owners invite (as owner or member), revoke invitations, remove members and change roles; a
    workspace always keeps at least one owner; what may a member do that an owner may also do, and
    what is owner-only (billing, deleting documents, renaming)?
21. **OQ-21 Email sign-in method.** Magic link, password, or both? Is email confirmation required?
22. **OQ-22 Spend cap month.** Calendar month in UTC, or another reset date? Who sees how much of
    the budget is used (only the operator, or users too)?
23. **OQ-23 Work at the cap.** When the cap is reached with documents still queued, do they wait
    until the cap resets (status "Waiting for budget") or fail? Is a new upload while the cap is
    reached refused (proposed in AC-6 of US-1.1), or accepted and left waiting?
24. **OQ-24 Billing details.** The Pro price to show in test mode and its currency; whether the
    allowance resets on the calendar month or the billing period; what a downgrade or cancellation
    does to pages already used; whether there is a trial.
25. **OQ-25 Demo details.** What can a visitor do on a sample (edit, approve, export) and is
    anything kept? Must the sample documents be fictitious, with no real person's or company's data
    (proposed in section 6)? Who makes them, and are the stored results produced by one reviewed
    real extraction or written by hand? How many samples per type?
26. **OQ-26 Eval set.** How many documents per type? Where do they come from (generated,
    public-domain, the operator's own with data removed)? Who checks the expected results? Is the
    eval run paid from the deployed app's $10 budget or from a separate key? Are each run's results
    kept in the repo with the date, model and prompt version (proposed in AC-4 of US-16.1)?
27. **OQ-27 Landing page content.** Headline, sections, screenshots, links to the portfolio and the
    repo? Is there a custom domain? Confirm or replace the proposal in AC-1 and AC-2 of US-15.1:
    the page says what doc-extract does, lists the six types, has a sign-up button beside the demo
    button, and shows the latest measured accuracy per type with its date and model.
28. **OQ-28 Field sets.** Confirm or change the proposed field sets and checks in section 4.1.
29. **OQ-29 Sensitive numbers.** Is storing only the last four digits of account numbers, IBANs
    and cards right (with a longer card number read from a receipt cut to its last four), or must
    the full number be extracted and exported?
30. **OQ-30 Account and workspace deletion.** Can a user delete their account and a workspace and
    its data? Is a privacy policy or terms page needed?
31. **OQ-31 Further channels.** Confirm that an email-in address, a public API and customer
    webhooks are out of scope for v1.
32. **OQ-32 Accuracy measure and targets.** Confirm or replace the proposed definition of field
    accuracy (exact match after normalisation), the proposed targets and the proposed
    check-usefulness measure in section 10. What happens when a type misses its target: does it
    block launch, or is it shown as measured?
33. **OQ-33 Abuse of sign-up.** The 10-page account cap can be multiplied by creating accounts,
    which drains the shared $10 budget. Is a captcha, email confirmation or another limit on
    sign-ups wanted?
34. **OQ-34 Sign-in behaviour.** Does signing in with Google and with email for the same address
    give one account (proposed), or two separate accounts? After signing in, is the user sent back
    to the page they first opened (proposed), or to a fixed start page?
35. **OQ-35 Live status delay.** How soon must a status change appear on open screens? Proposed:
    within 5 seconds.
36. **OQ-36 Upgrade delay.** How soon after Stripe's webhook must the workspace be Pro? Proposed:
    within 10 seconds.
37. **OQ-37 Cancellation.** Can an owner cancel Pro (proposed: through Stripe's customer portal), and
    does the workspace return to Free at the end of the paid period (proposed) or at once?
38. **OQ-38 Demo coverage.** Must the demo include a sample with a failed check, and must the
    samples together show every kind of flag (failed arithmetic check, date flag, low-confidence
    field, duplicate)? Proposed: yes to both.
39. **OQ-39 Deletion time bound.** How soon after a file is 7 days old must it be deleted? Proposed:
    within 24 hours (so no file is older than 8 days).
40. **OQ-40 Screen sizes.** Which widths must the app support? Proposed: phone width from 360px and
    desktop, with the review screen stacking the document above the fields at phone width.
41. **OQ-41 Dark theme.** Is a dark theme wanted in v1? Proposed: no, light theme only.
42. **OQ-42 Several files at once.** Can a user upload several files in one action, each becoming
    its own document? Proposed: yes. Is there a maximum number per action?
43. **OQ-43 Checks with missing inputs.** When a value a check needs is not printed (for example no
    tax), is the check recorded as "Skipped" (proposed), failed, or flagged as a missing field?
44. **OQ-44 Review screen details.** Confirm or replace the proposals in US-4.1 AC-7 and US-5.1 AC-1,
    AC-4 and AC-5: checks re-run and flags update live as the user corrects a field; all pages
    shown and zoomable; line items can be added and deleted; the original value stays visible
    beside a corrected one; who approved and when is recorded and shown.
45. **OQ-45 Notices.** Must the landing page and the upload screen state that files are deleted
    after 7 days, and must the landing page and the billing page state that billing is a test-mode
    demonstration accepting test cards only? Proposed: yes, in each of those places.
