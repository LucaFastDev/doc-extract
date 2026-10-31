# doc-extract: product requirements

Status: for the operator's review (issue #1). Nothing is built until this document and
[ARCHITECTURE.md](ARCHITECTURE.md) are approved.

Every requirement here is decided. The operator's answers of 2026-10-31 settled every open question
the first draft raised; where a requirement comes from one of those answers it names the question
(**OQ-n**), and the last section lists each question with its answer and where it is applied.

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
| F1 | Upload documents: PDF, JPEG, PNG or WebP, up to 10 files at once |
| F2 | Extraction with Claude: document type, fields, line items, per-field confidence |
| F3 | Six document types, each with its own field set and checks |
| F4 | Checks: arithmetic, date sanity, duplicate detection; a failed check flags fields |
| F5 | Review screen: document beside fields, flagged first; correct, approve and reopen |
| F6 | Export approved results of one type as CSV (zipped) and XLSX |
| F7 | English UI; documents in any language; amounts in the printed currency |
| F8 | Workspaces with copy-link invites; roles owner and member |
| F9 | Sign-in with Google |
| F10 | Live processing status |
| F11 | Billing in Stripe test mode: Free 20 pages a month, Pro 500 pages a month at $19 |
| F12 | Hard AI spend cap of $10 a month, with a daily ceiling of $2, for the deployed app |
| F13 | Public one-click demo with stored results; own uploads need an account, capped at 10 pages |
| F14 | Uploaded files are deleted after 7 days |
| F15 | Landing page, with the plans and the measured accuracy |
| F16 | Eval set with measured field accuracy per document type |
| F17 | A clean look defined on shadcn/ui, adjustable later |
| F18 | Account and workspace deletion; privacy and terms pages |
| F19 | Delete a single document |

## 3. User stories and acceptance criteria

Each criterion is written to be checked by a unit test, an access test or an end-to-end test in
which Claude is mocked. "The user" is a signed-in member of the current workspace unless a story
says otherwise.

### F1. Upload

**US-1.1** As a user, I want to upload a PDF, a photo or a scan of a business document, so that it
gets read without my retyping it.

- AC-1 (**OQ-4**): The upload control accepts PDF, JPEG, PNG and WebP files, by file picker and by
  drag and drop.
- AC-2: A file of any other type is refused before upload with a message naming the accepted
  types, and no document is created.
- AC-3 (**OQ-4**): A file over 10 MB is refused before upload with a message naming the limit. A
  PDF of more than 10 pages is refused with a message naming the limit, and no pages are counted.
- AC-4 (**OQ-42**): A user can upload up to 10 files in one action; each becomes its own document.
  Choosing more than 10 files is refused with a message naming the limit, and none is uploaded.
- AC-5: After a successful upload the document appears in the workspace's document list with
  status "Queued" and its page count.
- AC-6 (**OQ-2**, **OQ-3**): An upload that would take the workspace over its monthly page
  allowance (F11), or the uploading account over its lifetime cap of 10 pages (F13), is refused
  with a message saying how many pages remain under the lower of the two, and no pages are counted.
- AC-7 (**OQ-23**): While the AI spend cap or the daily ceiling is reached (F12), a new upload is
  accepted: the document gets status "Waiting for budget" and is processed when budget is
  available, with no action by the user. Its pages are held against the allowances like any queued
  document's (US-2.1 AC-6).

**US-1.2** As a user, I want each document to have the right type, so that the right fields are
extracted.

- AC-1 (**OQ-1**): Claude detects the type during extraction. Every extracted document has exactly
  one of the six types before its fields are shown.
- AC-2 (**OQ-1**): A document that is none of the six types gets status "Not supported", has no
  fields, and counts 0 pages.
- AC-3: The type is shown on the document list and the review screen.
- AC-4 (**OQ-1**): The user can change the type of a document in "Needs review" or "Not
  supported" to any of the six. After a confirmation, the document's fields, corrections and ticked
  checks are discarded, and it is extracted again as the chosen type, without type detection.
- AC-5 (**OQ-1**, **OQ-10**): A document's pages count once. Changing the type of a document in
  "Needs review" counts no further pages. Changing the type of a "Not supported" document holds its
  pages again, is refused like an upload if they no longer fit the allowances (US-1.1 AC-6), and
  counts them only if that extraction succeeds.
- AC-6: Changing the type is not offered once the document's file has been deleted (F14).

### F2. Extraction

**US-2.1** As a user, I want Claude to read my document and return its fields and line items, so
that I do not type them.

- AC-1: For each document, the result holds every field of its type's field set (section 4); a
  field not present on the document is stored as empty, not invented.
- AC-2: Line items (or transactions, for bank statements) are returned in the order printed.
- AC-3: Every field and every line-item cell has a confidence between 0 and 1.
- AC-4 (**OQ-8**): A field whose confidence is below 0.8 is flagged "Low confidence". The threshold
  is configuration, so it can be calibrated later against the eval set without a release.
- AC-5: Dates are stored in ISO 8601 (YYYY-MM-DD); amounts as exact decimals, with no rounding
  beyond what is printed.
- AC-6 (**OQ-10**): If extraction fails after its retries, the document has status "Failed" with a
  reason the user can read, and the user can retry it. A failed extraction counts 0 pages; a retry
  counts the document's pages only when it succeeds. Pages are held against the allowances while a
  document is queued, waiting or processing, and released when it fails or is not supported.
- AC-7: Retrying is not offered once the document's file has been deleted (F14).
- AC-8 (**OQ-5**): A multi-page document is extracted as one document. One file is one document; a
  file holding several documents is extracted as one, and splitting is out of scope (section 9).

### F3 and F4. Document types and checks

**US-3.1** As a user, I want each type to have the fields that matter for it, so that the output
fits how I use it. The field sets are in section 4.

- AC-1: Each of the six types has a field set, a line-item set and a list of checks, defined once
  and used by extraction, review, checks and export.

**US-4.1** As a user, I want the result checked, so that a misread number does not slip through.

- AC-1: Every check listed for a type in section 4 runs on every extraction of that type.
- AC-2: A check that fails flags each field it names, with a reason that says what did not add up
  (for example "Line items sum to 1,180.00; subtotal is 1,200.00").
- AC-3 (**OQ-43**): A check whose inputs are empty (for example no tax printed) is recorded as
  "Skipped", not as passed or failed.
- AC-4 (**OQ-7**): Arithmetic checks treat two amounts as equal when they differ by at most 0.01
  in the document's currency, or by at most 1 for a currency without decimals (ISO 4217 minor
  unit 0, such as JPY).
- AC-5 (**OQ-6**): Date sanity checks follow the rules in section 4.2.
- AC-6 (**OQ-9**): Duplicate detection flags a document that matches an earlier document in the
  same workspace by the rule in section 4.3, and links to the earlier one.
- AC-7 (**OQ-44**): When the user corrects a field on the review screen, the checks that use it
  are re-evaluated and the flags update without a page reload.

### F5. Review

**US-5.1** As a user, I want to see the document beside the extracted fields, flagged fields
first, so that I check what is doubtful before the rest.

- AC-1 (**OQ-44**): The review screen shows the original document beside the fields; all pages
  are shown, and the document can be zoomed.
- AC-2: Flagged fields (failed check, low confidence, duplicate, currency guessed) are listed
  before unflagged fields, each with its reason.
- AC-3: Each field shows its confidence.
- AC-4 (**OQ-44**): The user can edit any field and any line-item cell, add a missing line item
  and delete a wrong one. The original extracted value stays visible next to a corrected one.
- AC-5 (**OQ-11**): Each failed check has a tick box. The user can approve a document only when
  every failed check is ticked; while one is not, the approve button is disabled and the server
  refuses an approval. Flags that are not failed checks (low confidence, currency guessed) do not
  block approval.
- AC-6 (**OQ-44**): Approving gives the document status "Approved"; who approved it and when is
  recorded and shown.
- AC-7 (**OQ-12**): Any member can reopen an approved document. It returns to "Needs review", its
  approval is cleared, and the reopen (who and when) is logged and shown in the document's history
  beside the approvals.
- AC-8 (**OQ-14**): After the file is deleted (F14), the review screen still shows the fields and
  checks, and says the file was deleted 7 days after upload.

### F6. Export

**US-6.1** As a user, I want to export approved results as CSV and XLSX, so that I can bring them
into a spreadsheet or another tool.

- AC-1: Only approved documents can be exported.
- AC-2: An export contains the corrected value where there is one, and the extracted value
  otherwise.
- AC-3 (**OQ-13**): One export holds the approved documents of one type that the user chooses.
  The user first picks the type, then the documents.
- AC-4 (**OQ-13**): XLSX holds two sheets: "Documents", one row per document with its header
  fields, and "Line items", one row per line item (or transaction) with the document's id and file
  name and the line's position. Amounts are numbers and dates are dates.
- AC-5 (**OQ-13**): CSV is a zip of two files, `documents.csv` and `line_items.csv`, laid out as
  the two sheets. Each is UTF-8 with a header row and RFC 4180 quoting, with amounts as plain
  decimals without thousands separators and the currency in its own column.
- AC-6: QuickBooks, Xero or any other accounting integration is not offered (section 9).

### F7. Language and currency

**US-7.1** As a user with documents in other languages and currencies, I want them read as they
are, so that my figures stay correct.

- AC-1: Every screen and message of the app is in English. The app sends no email (F9).
- AC-2 (**OQ-15**): A document in any language is accepted and extracted; text fields keep the
  language as printed, with no translation.
- AC-3: Amounts are kept in the currency printed on the document; nothing is converted.
- AC-4: Each document records its currency as an ISO 4217 code and as printed.
- AC-5 (**OQ-16**): When the document prints no currency, Claude guesses it from context and the
  currency field is flagged "Currency guessed". A printed symbol that stands for several currencies
  (such as "$" or "kr") counts as no currency printed. A delivery note, which has no amounts, is
  not flagged for its currency.

### F8. Workspaces, invites and roles

**US-8.1** As a new user, I want a workspace, so that my documents are kept apart from everyone
else's.

- AC-1: A user can see documents, fields and exports only of workspaces they are a member of;
  this is enforced by the database, not only by the UI.
- AC-2 (**OQ-17**): A personal workspace, with the user as its owner, is created at their first
  sign-in.
- AC-3 (**OQ-17**): A user can belong to several workspaces, switch between them, and create a
  new one.
- AC-4 (**OQ-17**): An owner can rename the workspace and delete it (F18).

**US-8.2** As a workspace owner, I want to invite people, so that we can share the work.

- AC-1 (**OQ-19**, **OQ-20**): An owner creates an invitation for an email address, as owner or
  member. The app shows the invitation as a link with a copy button; no email is sent.
- AC-2 (**OQ-18**): Only someone signed in with a Google account of that email address can accept
  the invitation; they become a member with the invited role. Anyone else who opens the link is
  told it is not for them, and nothing changes.
- AC-3 (**OQ-18**): An invitation can be accepted once, and expires 7 days after it is created.
- AC-4 (**OQ-20**): An owner can revoke a pending invitation, remove a member and change a
  member's role.
- AC-5 (**OQ-20**): A workspace always has at least one owner: removing or demoting the last owner
  is refused.
- AC-6 (**OQ-20**): A member cannot invite, revoke invitations, remove members or change roles.
- AC-7 (**OQ-20**): Owners manage members, invitations and billing, and rename and delete the
  workspace. Members and owners both upload, review, correct, approve, reopen, change types, retry,
  export and delete single documents (F19).

### F9. Sign-in

**US-9.1** As a user, I want to sign in with my Google account.

- AC-1 (**OQ-19**, **OQ-21**): The only way to sign in is Google. The sign-in page has one "Continue
  with Google" button and no email form; there is no password and no magic link.
- AC-2 (**OQ-34**): Signing out ends the session. A signed-out visitor who opens an app page is
  sent to sign-in, and after signing in is sent back to that page.

### F10. Live status

**US-10.1** As a user, I want to see each document's processing status change as it happens, so
that I do not reload the page.

- AC-1 (**OQ-1**, **OQ-23**): The statuses shown are: Queued, Processing, Waiting for budget,
  Needs review, Approved, Failed and Not supported.
- AC-2 (**OQ-35**): A status change made on the server appears on every open document list and
  review screen of that workspace within 5 seconds, without a reload.
- AC-3: A user never receives status updates for another workspace's documents.

### F11. Billing (Stripe test mode)

**US-11.1** As an owner, I want to move the workspace to Pro, so that we get more pages.

- AC-1: The billing page shows the current plan, pages used this month and pages left.
- AC-2 (**OQ-2**, **OQ-3**): Page allowances are per workspace per calendar month (UTC): Free 20,
  Pro 500. Separately, each account has a lifetime cap of 10 pages on the deployed site, on any
  plan (US-13.2).
- AC-3 (**OQ-24**, **OQ-36**): Upgrading opens Stripe Checkout **in test mode** for Pro at $19 a
  month in USD, with no trial; completing it with a Stripe test card makes the workspace Pro within
  10 seconds of Stripe's webhook.
- AC-4: The app never creates a real charge: the server refuses to start if its Stripe key is a
  live key.
- AC-5 (**OQ-45**): The billing page says plainly that billing is a test-mode demonstration and
  that only test cards are accepted.
- AC-6 (**OQ-24**, **OQ-37**): An owner can cancel through Stripe's customer portal; the workspace
  drops to Free at the end of the paid period.
- AC-7 (**OQ-22**, **OQ-24**): The allowance resets at the start of each calendar month (UTC),
  not on the billing date. Pages used in a month stay counted when the plan changes, so a workspace
  that drops to Free with more than 20 pages used that month uploads nothing more until the next
  month.
- AC-8 (**OQ-20**): Only owners can upgrade or cancel; members see the plan and the pages left.

### F12. AI spend cap

**US-12.1** As the operator, I want AI spending to stop at $10 a month and $2 a day, so that the
deployed demo can never cost me more, and one bad day cannot use up the month.

- AC-1 (**OQ-22**, **OQ-33**): The app's total Claude spend never exceeds $10 in a calendar month
  (UTC) or $2 in a day (UTC), enforced on the server before each Claude call, using an upper-bound
  estimate so that concurrent calls cannot pass either limit together.
- AC-2 (**OQ-23**): When the next extraction would pass either limit, no Claude call is made. The
  document gets status "Waiting for budget", and is processed without any user action once budget
  is available: the next UTC day for the daily ceiling, the next month for the monthly cap.
- AC-3 (**OQ-22**): Signed-in users see "$x of $10 used this month". While the daily ceiling or
  the monthly cap is reached, they also see which one, and when waiting documents resume (wording
  adjustable).
- AC-4: Signing in, reviewing, approving, exporting and the public demo keep working while either
  limit is reached.
- AC-5: The monthly cap and the daily ceiling are configuration, not code, so the operator can
  change them without a release.
- AC-6: The provider's own monthly limit for the API key is also set to $10 (docs/go-live.md), so
  a fault in the app's accounting cannot spend more.
- AC-7 (**OQ-26**): The eval (F16) does not use the app's key and is outside both limits.

### F13. Public demo

**US-13.1** As a visitor, I want to try the product in one click without signing up.

- AC-1: The landing page has one button that opens the demo, with no sign-up and no sign-in.
- AC-2: The demo offers fixed sample documents, at least one of each of the six types.
- AC-3 (**OQ-38**): Opening a sample shows its stored result on the review screen: document,
  fields, line items, confidences, checks and flags. At least one sample has a failed check, and
  the samples together show every kind of flag: a failed arithmetic check, a date flag, a
  low-confidence field and a duplicate.
- AC-4: The demo never calls Claude: opening every sample leaves the app's AI spend unchanged.
- AC-5 (**OQ-25**): A visitor can edit fields and export a sample; this happens in the browser
  only, nothing is saved, and a reload restores the stored result.
- AC-6: The demo offers sign-in with Google for uploading one's own documents.

**US-13.2** As a visitor who signs up, I want to upload my own documents.

- AC-1: Uploading needs an account.
- AC-2 (**OQ-2**): On the deployed site, an account can process at most 10 pages in its lifetime,
  on any plan and across all its workspaces. The cap is configuration.
- AC-3: The upload screen shows how many of the account's 10 pages are left, and how many pages
  the workspace has left this month.

### F14. Retention

**US-14.1** As a user, I want my uploaded files deleted after 7 days, so that my documents are not
kept longer than needed.

- AC-1 (**OQ-14**, **OQ-39**): Every uploaded file is deleted from storage within 24 hours after
  it is 7 days old, measured from upload, on every plan.
- AC-2: Deletion runs on a schedule with no person involved, and a failed deletion is retried on
  the next run.
- AC-3: The demo's sample files are not deleted.
- AC-4 (**OQ-45**): The landing page and the upload screen say that files are deleted after 7
  days.
- AC-5 (**OQ-14**, **OQ-30**): Extracted fields, check results and approvals are kept after the
  file is deleted, until a member deletes the document (F19) or the user deletes the workspace or
  their account (F18).

### F15. Landing page

**US-15.1** As a visitor, I want to understand in a few seconds what the product does.

- AC-1 (**OQ-27**): A public landing page at `/` says what doc-extract does, lists the six
  document types, and shows the demo button (F13) and a sign-in button.
- AC-2 (**OQ-27**): It shows the plans and their page limits to visitors who are not signed in:
  Free 20 pages a month, Pro 500 pages a month at $19, and the 10-page limit per account.
- AC-3 (**OQ-27**, **OQ-32**): It shows the measured accuracy per document type from the latest
  eval run (F16), with the date of that run and the model used.
- AC-4 (**OQ-45**): It states the 7-day file deletion and that billing is in test mode.
- AC-5 (**OQ-27**): It links to the repo and to the operator's portfolio. The site is served on
  its vercel.app address; there is no custom domain.
- AC-6 (**OQ-30**): It links to the privacy and terms pages (US-18.3).
- AC-7 (**OQ-27**): The Lead writes its copy.

### F16. Eval set

**US-16.1** As the operator, I want field accuracy measured per document type, so that I can show
how well it works and catch regressions when the prompt or model changes.

- AC-1 (**OQ-26**): The repo holds an eval set of 5 fictitious documents per type (30 in all),
  made by a worker, each with an expected result. The PR reviewer checks the expected results
  against the documents.
- AC-2: One command runs the eval against the real Claude API and writes, per document type, the
  field accuracy defined in section 10.
- AC-3 (**OQ-26**): The eval never runs in CI and never runs on its own. The operator runs it on
  their laptop with their own key, outside the deployed app's spend cap.
- AC-4 (**OQ-26**): Each run's results are committed to the repo with the date, the model and the
  prompt version.
- AC-5: The scoring (comparing a result to an expected result) has unit tests.
- AC-6 (**OQ-32**): The measured accuracy is shown (F15); missing a target in section 10 does not
  block a release.

### F17. Look

**US-17.1** As the operator, I want a clean, consistent look I can adjust later.

- AC-1: Every colour, radius and font the app uses comes from design tokens (CSS variables) in
  `src/app/globals.css`, as shadcn/ui lays them out and imported by the root layout, so the look changes
  in one place.
- AC-2: UI components come from shadcn/ui.
- AC-3 (**OQ-40**): The app works at phone width (from 360px) and desktop width; the review screen
  stacks the document above the fields at phone width.
- AC-4 (**OQ-41**): Light theme only; a dark theme is not in v1.

### F18. Account and workspace deletion, privacy and terms

**US-18.1** As an owner, I want to delete a workspace, so that its data is gone when we are done.

- AC-1 (**OQ-17**, **OQ-30**): An owner can delete the workspace after typing its name to confirm.
  Its documents, files, fields, check results, history, invitations, memberships and page usage are
  deleted. An active Pro subscription is cancelled at once in Stripe test mode.
- AC-2: A member cannot delete the workspace.

**US-18.2** As a user, I want to delete my account, so that the app keeps nothing of mine.

- AC-1 (**OQ-30**): A user can delete their account after a confirmation. Workspaces where they
  are the only member are deleted as in US-18.1; their membership of every other workspace is
  removed. Documents they uploaded to a workspace that remains stay there, shown as uploaded by
  "a deleted user".
- AC-2 (**OQ-20**, **OQ-30**): Deleting the account is refused while the user is the only owner of
  a workspace that has other members, with a message to make another member an owner or to delete
  that workspace first.

**US-18.3** As a visitor, I want to know how my data is handled.

- AC-1 (**OQ-30**): Short privacy and terms pages are public at `/privacy` and `/terms`, linked
  from the landing page and the sign-in page. The privacy page states that documents are read by
  Claude, that files are deleted after 7 days, that sign-in is through Google and that billing is
  in Stripe test mode. The Lead writes their copy.

### F19. Single-document deletion

**US-19.1** As a user, I want to delete a document, so that a wrong or unwanted upload is gone.

- AC-1 (**OQ-20**): Any member of a workspace, owner or member, can delete any document in it,
  whoever uploaded it and whatever its status, from the document list and the review screen.
- AC-2 (**OQ-20**): Before deleting, the app asks for a confirmation that names the file.
  Cancelling it leaves the document unchanged; nothing is deleted without the confirmation.
- AC-3 (**OQ-20**): Deleting removes the document, its stored file and its extracted results:
  fields, line items, corrections, check results, ticks and history. Afterwards the document is
  not in the document list, its review screen says it no longer exists, it cannot be exported, and
  its file is no longer in storage.
- AC-4 (**OQ-20**): Pages the document used are not refunded: the workspace's pages used this
  month and the uploader's lifetime pages (F11, F13) are the same after the deletion as before,
  and still count towards the limits.
- AC-5 (**OQ-10**, **OQ-20**): A document deleted while it is queued, waiting for budget or
  processing has used no pages yet (section 5); the pages held for it are released, as for a
  failure (US-2.1 AC-6).
- AC-6 (**OQ-20**): Someone who is not a member of the workspace, or not signed in, cannot delete
  its documents; the server refuses, and nothing changes.
- AC-7: The demo's samples (F13) cannot be deleted; the demo shows no delete action.

## 4. Document types: field sets and checks

The field sets and checks below are decided (**OQ-28**). The issue fixed the six types, the three
kinds of check and three arithmetic checks (line items sum to subtotal, subtotal + tax = total,
opening balance + transactions = closing balance); the operator confirmed the rest as drafted.

Every type also has these common fields: `language` (detected, BCP 47 code), `currency` (ISO 4217
code), `currency_as_printed`. The currency rule of US-7.1 AC-5 (**OQ-16**) applies to every type
that has amounts.

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

`card_last4` holds at most four digits; anything longer read from the document is cut to its last
four (**OQ-29**).

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

A delivery note has no amounts, so `currency` may be empty and is not flagged.

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

Decided (**OQ-6**): a date is flagged when it is in the future by more than one day (allowing for
time zones), when it comes before 2000-01-01, or when it breaks an ordering rule of its type (D2
above).

### 4.3 Duplicate detection (all types)

Decided (**OQ-9**): two documents are duplicates when, within the same workspace, either the
uploaded files are byte-identical (same SHA-256), or the type's U1 key matches after
normalisation (case, whitespace and punctuation removed from names and numbers). A duplicate is
flagged, not refused, and links to the earlier document. There is no time window, and documents
whose files were deleted still count, because their hash and fields are kept (F14).

## 5. Plans, limits and the spend cap

| Limit | Value | Source |
|---|---|---|
| Free plan | 20 pages per workspace per month | issue; OQ-2, OQ-3 |
| Pro plan | 500 pages per workspace per month; $19 a month in USD, test mode, no trial | issue; OQ-2, OQ-3, OQ-24 |
| Own uploads per account | 10 pages for the account's lifetime, on any plan, on the deployed site | issue; OQ-2 |
| One document | at most 10 MB and 10 pages; PDF, JPEG, PNG or WebP | OQ-4 |
| One upload | at most 10 files | OQ-42 |
| AI spend, whole deployed app | $10 a calendar month, hard stop | issue; OQ-22 |
| AI spend, whole deployed app, per day | $2 a UTC day, under the monthly cap | OQ-33 |
| Billing | Stripe test mode only, never real charges | issue |
| What a page is | one PDF page; one image file = one page | OQ-2 |
| What counts | a document's pages, once, when its extraction succeeds; a failed or Not supported document counts 0 | OQ-1, OQ-10 |
| Period | calendar month, UTC, on every plan | OQ-22, OQ-24 |

An upload must fit both the workspace's monthly allowance and the uploader's lifetime cap. The
spend cap and the daily ceiling apply to the whole deployed app, not to each workspace, and the
demo does not count against them because it makes no Claude calls. Work that would pass either
waits as "Waiting for budget" (F12). Deleting a document does not give back the pages it used
(F19). There is no captcha or other sign-up limit (**OQ-33**): the account cap and the daily
ceiling are the abuse limits.

## 6. The demo

- One click from the landing page, no account.
- Fixed sample documents, at least one per type, chosen so that together they show every kind of
  flag: a failed arithmetic check, a date flag, a low-confidence field and a duplicate (**OQ-38**).
- **Results are hardcoded**: each sample's stored extraction result is shown; nothing is
  re-extracted per visitor and the demo never calls Claude.
- The sample documents are fictitious, with no real person's or company's data (**OQ-25**). As for
  the eval set (**OQ-26**), a worker makes them and writes their stored results by hand, and the PR
  reviewer checks the results against the documents.
- A visitor's edits and exports stay in the browser; nothing is saved (**OQ-25**).
- Uploading one's own documents needs an account, capped at 10 pages per account (F13).

## 7. Retention

- Uploaded files are deleted within 24 hours after they are 7 days old, counted from upload, by a
  scheduled job, on every plan (F14; **OQ-14**, **OQ-39**).
- Demo sample files are kept.
- Extracted fields, check results and approvals are kept after the file is deleted, until the
  document, the workspace or the account is deleted (**OQ-14**, **OQ-20**, **OQ-30**).
- Deleting a document deletes its file and all its data at once (F19; **OQ-20**).
- Deleting a workspace deletes all its data; deleting an account deletes the workspaces where the
  user is the only member (F18; **OQ-30**).

## 8. Non-functional requirements

- The Claude API key exists only in the Edge Functions that call Claude; it never reaches the
  browser or the Next.js app.
- Server-only secrets (the Supabase service role key, the Stripe secret key) are read only in
  server code and never have a `NEXT_PUBLIC_` name.
- Every table is protected by row level security; a user reaches only their workspaces' data.
- Every test and end-to-end run mocks Claude; CI never calls the Claude API and holds no key.
- A missing backend setting fails loudly at startup; nothing falls back to a production service.
- Stripe runs in test mode only; a live key is refused at startup.

## 9. Out of scope for v1

- QuickBooks, Xero or any other accounting integration; any export other than CSV and XLSX.
- Real payments; Stripe live mode; trials.
- A UI language other than English; translation of document text (**OQ-15**); currency
  conversion.
- Re-extracting demo documents per visitor.
- Roles other than owner and member.
- Sign-in methods other than Google; any email the app sends (**OQ-19**, **OQ-21**).
- A custom domain (**OQ-27**).
- A captcha or other sign-up limit (**OQ-33**).
- Mobile apps, an email-in address, a public API or webhooks for customers (**OQ-31**).
- Several documents in one file (**OQ-5**); a dark theme (**OQ-41**).

## 10. Success measures

**Field accuracy**, measured by the eval set (F16). Definition (**OQ-32**): for a document type,
the share of expected field values (header fields and line-item cells) that the extraction returns
exactly, after normalisation (dates as ISO 8601, amounts as decimals, text with case and
surrounding whitespace ignored). An empty expected value counts as correct only when the
extraction is also empty.

**Targets** (**OQ-32**). They are shown beside the measured accuracy; missing one does not block a
release.

| Type | Header fields | Line items / transactions |
|---|---|---|
| Invoice | ≥ 95% | ≥ 90% |
| Receipt | ≥ 92% | ≥ 85% |
| Bank statement | ≥ 95% | ≥ 95% |
| Purchase order | ≥ 95% | ≥ 90% |
| Delivery note | ≥ 95% | ≥ 90% |
| Quote | ≥ 95% | ≥ 90% |

Other measures:

- **Check usefulness** (**OQ-32**): in the eval set, every seeded misread of a total or subtotal
  is flagged by an arithmetic check.
- **Demo**: a visitor reaches a sample's review screen in one click from the landing page.
- **Cost**: the deployed app's Claude spend stays at or under $10 in every month and $2 in every
  day.

## Open questions and answers

Every question the first draft raised was answered by the operator on 2026-10-31 (issue #1). Where
the operator gave no separate answer, the draft's own proposal was taken, as the operator
directed. Each entry gives the answer and where it is applied.

1. **OQ-1 Document type selection.** Claude detects the type and the user can change it. A document
   that is none of the six types is "Not supported" and counts 0 pages. Applied: US-1.2, US-10.1
   AC-1, section 5.
2. **OQ-2 Page limits.** Free 20 and Pro 500 pages a month per workspace; in addition, the deployed
   site limits each account to 10 pages for its lifetime, on any plan. An image file is one page.
   Applied: US-1.1 AC-6, US-11.1 AC-2, US-13.2, section 5.
3. **OQ-3 Plan scope.** Per workspace. Applied: US-1.1 AC-6, US-11.1 AC-2, section 5.
4. **OQ-4 Accepted files.** PDF, JPEG, PNG and WebP; at most 10 MB and 10 pages per document.
   Applied: US-1.1 AC-1 and AC-3, section 5.
5. **OQ-5 Several documents in one file.** One file is one document; splitting is out of scope.
   Applied: US-2.1 AC-8, section 9.
6. **OQ-6 Date sanity rules.** As drafted: more than one day in the future, before 2000-01-01, or
   breaking the type's ordering rule. Applied: US-4.1 AC-5, section 4.2.
7. **OQ-7 Arithmetic tolerance.** 0.01, or 1 for currencies without decimals. Applied: US-4.1 AC-4.
8. **OQ-8 Confidence.** Flag a field below 0.8 model confidence; calibrate later. Applied: US-2.1
   AC-4.
9. **OQ-9 Duplicate rule.** As drafted: same file hash or same U1 key after normalisation, within
   the workspace, with no time window; documents whose files were deleted still count. Applied:
   US-4.1 AC-6, section 4.3.
10. **OQ-10 Failed extractions and the allowance.** A failed document can be retried. A failure
    counts 0 pages, and a retry counts only when it succeeds. Applied: US-1.2 AC-5, US-2.1 AC-6 and
    AC-7, section 5.
11. **OQ-11 Approving with failed checks.** Allowed once the user has ticked each failed check.
    Applied: US-5.1 AC-5.
12. **OQ-12 Reopening.** Any member can reopen an approved document; the approval is cleared and
    the reopen is logged. Applied: US-5.1 AC-7.
13. **OQ-13 Export layout and format.** One export holds the chosen approved documents of one type.
    XLSX has two sheets (Documents, Line items); CSV is two files in a zip; the drafted CSV and XLSX
    formats stand. Applied: US-6.1 AC-3 to AC-5.
14. **OQ-14 Retention scope.** As drafted: only files are deleted, 7 days from upload, on every
    plan; extracted data stays until the workspace or account is deleted, or, since the change to
    OQ-20, the document. Applied: US-5.1 AC-8, US-14.1 AC-1 and AC-5, section 7.
15. **OQ-15 Translation.** No translation; text is kept as printed. Applied: US-7.1 AC-2,
    section 9.
16. **OQ-16 Missing currency.** Claude guesses it and the field is flagged. Applied: US-7.1 AC-5,
    US-5.1 AC-2, section 4.
17. **OQ-17 Workspace creation.** A personal workspace is created at first sign-in; a user can
    belong to several; the owner renames and deletes. Applied: US-8.1 AC-2 to AC-4, US-18.1.
18. **OQ-18 Invitation rules.** Invitations expire after 7 days; as drafted, only someone signed in
    with the invited email address can accept, and only once. Applied: US-8.2 AC-2 and AC-3.
19. **OQ-19 Invitation and sign-in email.** There is no domain and no email sender. Invitations are
    shared as a copy-link. Applied: US-8.2 AC-1, US-9.1 AC-1, US-7.1 AC-1, section 9.
20. **OQ-20 Roles.** As drafted: owners invite, revoke, remove members, change roles and manage
    billing; a workspace keeps at least one owner; members and owners both upload, review, approve
    and export. Changed by the operator's answer of 2026-10-31 on the review of PR #5: v1 has
    single-document delete. Any member can delete any document of the workspace; its row, stored
    file and extracted results are removed; the pages it used are not refunded and still count; the
    UI asks for confirmation first. Applied: US-8.2 AC-4 to AC-7, US-11.1 AC-8, US-18.2 AC-2,
    US-19.1, sections 5, 7 and 9.
21. **OQ-21 Email sign-in method.** None: sign-in is Google only, with no email sign-in and no magic
    link; F9 is "Sign-in with Google". Applied: section 2 (F9), US-9.1 AC-1, section 9.
22. **OQ-22 Spend cap month and visibility.** Calendar month in UTC; signed-in users see "$x of $10
    used this month". Applied: US-11.1 AC-7, US-12.1 AC-1 and AC-3, section 5.
23. **OQ-23 Work at the cap.** New documents are accepted and wait as "Waiting for budget", and are
    processed when budget is available; this replaces the draft's refusal of uploads at the cap.
    Applied: US-1.1 AC-7, US-10.1 AC-1, US-12.1 AC-2.
24. **OQ-24 Billing details.** Pro is $19 a month in USD, Stripe test mode, no trial. A cancelled
    plan drops to Free at the end of the period. The allowance resets on the calendar month.
    Applied: US-11.1 AC-3, AC-6 and AC-7, section 5.
25. **OQ-25 Demo details.** As drafted: fictitious samples; edits and exports stay in the browser.
    Applied: US-13.1 AC-5, section 6.
26. **OQ-26 Eval set.** A worker makes 5 fictitious documents per type and the reviewer checks
    their expected answers. The eval runs on the operator's laptop key, outside the cap, and the
    results are committed. Applied: US-16.1 AC-1, AC-3 and AC-4, US-12.1 AC-7, section 6.
27. **OQ-27 Landing page content.** The Lead writes the copy. The landing page shows the plans and
    their page limits to visitors who are not signed in, and links to the repo and the operator's
    portfolio, on a vercel.app address. Applied: US-15.1.
28. **OQ-28 Field sets.** As drafted. Applied: section 4.
29. **OQ-29 Sensitive numbers.** As drafted: last four characters only. Applied: section 4.1.
30. **OQ-30 Account and workspace deletion.** Users can delete their account and their workspace;
    there are short privacy and terms pages. Applied: F18, US-14.1 AC-5, US-15.1 AC-6, section 7.
31. **OQ-31 Further channels.** As drafted: out of scope. Applied: section 9.
32. **OQ-32 Accuracy measure and targets.** The drafted definition, targets and check-usefulness
    measure stand; the measured accuracy is shown, not a release blocker. Applied: US-16.1 AC-6,
    US-15.1 AC-3, section 10.
33. **OQ-33 Abuse of sign-up.** No captcha. The limits are the 10-page per-account cap and a global
    ceiling of $2 a day on all AI use, under the $10 monthly cap. Applied: US-12.1 AC-1, section 5,
    section 9.
34. **OQ-34 Sign-in behaviour.** As drafted: after signing in, the user returns to the page they
    first opened. (Merging Google and email accounts no longer arises.) Applied: US-9.1 AC-2.
35. **OQ-35 Live status delay.** As drafted: within 5 seconds. Applied: US-10.1 AC-2.
36. **OQ-36 Upgrade delay.** As drafted: within 10 seconds of the webhook. Applied: US-11.1 AC-3.
37. **OQ-37 Cancellation.** As drafted: through Stripe's customer portal, back to Free at the end of
    the paid period. Applied: US-11.1 AC-6.
38. **OQ-38 Demo coverage.** As drafted: yes to both. Applied: US-13.1 AC-3, section 6.
39. **OQ-39 Deletion time bound.** As drafted: within 24 hours. Applied: US-14.1 AC-1, section 7.
40. **OQ-40 Screen sizes.** As drafted: from 360px, document stacked above the fields at phone
    width. Applied: US-17.1 AC-3.
41. **OQ-41 Dark theme.** As drafted: light theme only. Applied: US-17.1 AC-4, section 9.
42. **OQ-42 Several files at once.** Yes, at most 10 files per upload. Applied: US-1.1 AC-4,
    section 5.
43. **OQ-43 Checks with missing inputs.** As drafted: "Skipped". Applied: US-4.1 AC-3.
44. **OQ-44 Review screen details.** As drafted: live re-check, all pages and zoom, add and delete
    line items, original value beside the correction, approver and time shown. Applied: US-4.1
    AC-7, US-5.1 AC-1, AC-4 and AC-6.
45. **OQ-45 Notices.** As drafted: the landing page and upload screen state the 7-day deletion; the
    landing page and billing page state test-mode billing. Applied: US-11.1 AC-5, US-14.1 AC-4,
    US-15.1 AC-4.
