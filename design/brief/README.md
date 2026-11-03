# doc-extract: design brief

Everything Claude Design needs to design doc-extract: this brief, and a screenshot of every page in
`screenshots/`. All names, addresses, numbers and e-mail addresses in the screenshots are invented.

## 1. Paste this into Claude Design

```text
I want a visual design for doc-extract, a small web app that reads business documents (invoices,
receipts, bank statements, purchase orders, delivery notes, quotes) with AI, checks the numbers, and
lets a person review, approve and export the result to CSV or Excel.

Design these pages, each for desktop (1440 px wide) and phone (390 px wide): the landing page,
sign-in, the public demo (sample list and a sample's review screen), the document list with its upload
area, the review screen of one document (needs review with a failed check, and approved), export,
members, billing, the invitation page, privacy, terms, the not-found page and the "You are not in any
workspace." page.

This repo is imported from GitHub. In design/brief/ you will find README.md, which describes every page,
what must stay and what is free to change, and screenshots/, which shows the current pages with their
real content (desktop and phone, one pair per page and state). The current look is plain shadcn/ui and
is only a placeholder.

Before designing anything, propose two or three different visual directions for the whole app, each as
a short description with a sketch of the document list and the review screen, and let me choose one.
Then design the pages in the direction I choose.
```

## 2. What the app is and who uses it

doc-extract turns business documents into checked, structured data. A person uploads a PDF, a phone
photo or a scan; Claude reads it and returns every field and line item with a confidence for each.
The app then **checks** the result (do the lines add up to the subtotal, does the total match, are the
dates plausible, is it a duplicate) and puts anything doubtful in front of a person first. The person
corrects values, ticks off failed checks they accept, approves, and exports approved documents as CSV
or XLSX.

- **Users:** small businesses, bookkeepers and freelancers who now retype documents into spreadsheets.
  Work happens in English; the documents can be in any language and currency.
- **Visitors:** people arriving from the operator's portfolio. They must see the product working in one
  click, without signing up (the public demo with stored sample results).
- **Workspaces:** documents live in workspaces shared by a few people; owners also manage members and billing.
- **Tone:** a trustworthy working tool, calm and precise. Numbers and warnings must be unmistakable.
- Billing runs in Stripe test mode only; uploaded files are deleted after 7 days.

## 3. Pages

File names below are in `screenshots/`; each has a `-desktop.png` (1440×900 viewport) and a
`-phone.png` (390×844 viewport) version, full page height.

Signed-in pages share a header: the product name, the **workspace switcher** (a menu listing the
user's workspaces, with Members, Billing and Create workspace entries), **Delete account** and **Sign
out**. Public pages have no switcher. These menus and the dialogs mentioned below (Create workspace,
Invite someone, Change type, delete confirmations) are not in the screenshots except where named; design
them in the same system.

### Landing page `/`

- **For:** a first-time visitor deciding whether to try it.
- **Does:** reads what it is, opens the demo, or signs in.
- **Elements:** headline "Business documents in, checked data out"; intro paragraph; primary button
  "Try the demo" with "No sign-up. Sample documents, nothing saved."; secondary button "Sign in"; "How it
  works" (three steps: Upload, Check, Approve and export); "Six document types"; "Measured accuracy"
  (currently "The first accuracy run has not been published yet.", later a table of accuracy figures per
  type); "Plans" (Free: 20 pages a month per workspace, $0; Pro: 500 pages a month per workspace, $19 a
  month) with three notes (Stripe test mode, 10 pages per account, files deleted after 7 days); footer
  links Source code, Privacy, Terms. (A portfolio link also appears in the footer when configured; it is
  not configured in the screenshots.)
- **Screenshots:** `landing-signed-out-desktop.png`, `landing-signed-out-phone.png`

### Sign-in `/sign-in`

- **For:** getting into the app. Google is the only way in: no password, no e-mail form.
- **Elements:** card "Sign in to doc-extract" with one explanatory sentence and the button "Continue
  with Google"; Privacy and Terms links.
- **Screenshots:** `sign-in-default-desktop.png`, `sign-in-default-phone.png`

### Demo: sample list `/demo`

- **For:** trying the product without an account. Nothing is saved and no AI is called.
- **Elements:** header "doc-extract · Demo"; title and explanation; seven sample cards, each with a title,
  document type and page count, a one-line summary of what it shows (a failed total, a duplicate, low
  confidence, a date error, and so on) and an arrow; a "Your own documents" panel with "Sign in with
  Google" (signed-in visitors see "Go to your documents" instead).
- **Screenshots:** `demo-sample-list-desktop.png`, `demo-sample-list-phone.png`

### Demo: a sample with a failed check `/demo/invoice-total-mismatch`

- **For:** showing the whole review screen on a PDF invoice whose printed total is wrong.
- **Elements:** back link "Samples"; file name; Type and Pages; the document viewer (all pages, zoom
  − / +); **Checks** list (A3 Failed with its explanation and a "Tick A3" tick box, A4 Skipped, the rest
  Passed); **Export** (XLSX or CSV radio choice and Download); **Flagged fields** (each flagged field
  with its reason in red, editable value and confidence); **Fields**; **Line items** with Add line and
  Delete per line. The review screen is described fully under `/documents/[id]`; the demo has Export
  in place of Approve.
- **Screenshots:** `demo-invoice-total-mismatch-failed-check-desktop.png`,
  `demo-invoice-total-mismatch-failed-check-phone.png`

### Demo: a photographed document `/demo/receipt-photo`

- **For:** showing an image document (a photographed till receipt) with low-confidence fields.
- **Elements:** same screen; the viewer shows a photo instead of PDF pages; two fields flagged "Low
  confidence (58%)" and "(66%)"; every check passes.
- **Screenshots:** `demo-receipt-photo-image-document-desktop.png`,
  `demo-receipt-photo-image-document-phone.png`

### Document list `/documents`

The home of a signed-in user. Three screenshots show its states.

- **Elements:** title "Documents"; "Export" button; **upload area** (drop zone with the limits text "Drop
  up to 10 files here, or choose them. PDF, JPEG, PNG or WebP. PDFs at most 10 MB, images at most 7.5 MB,
  and 10 pages each.", "Choose files" button, "Files are deleted 7 days after upload.", the pages-left line
  "N of your account's 10 pages left · N of this workspace's 20 pages left this month", and the AI budget
  line "$3.40 of $10 used this month", which can add a notice when a daily or monthly AI limit is reached);
  a drag-over state of the drop zone; messages for refused uploads ("Nothing was uploaded.") and an
  uploading progress line; then either the empty message "No documents in <workspace> yet." or the table.
- **Table:** Name, Type, Status, Pages and a delete (trash) button per row. Statuses: **Queued**,
  **Processing**, **Waiting for budget** (with a reason), **Needs review**, **Approved**, **Failed** (with
  a reason and a Retry button) and **Not supported** (with a reason). Rows change status live, without
  reload. Names of documents that can be opened (Needs review, Approved, Not supported) are links.
- **Screenshots:**
  - Empty workspace: `documents-empty-workspace-desktop.png`, `documents-empty-workspace-phone.png`
  - A list with a document in every status: `documents-list-all-statuses-desktop.png`,
    `documents-list-all-statuses-phone.png`
  - Upload area with pages left and the budget line, above a short list:
    `documents-upload-area-pages-left-and-budget-desktop.png`,
    `documents-upload-area-pages-left-and-budget-phone.png`

### Review screen `/documents/[id]`

The most important screen: a person checks what was read against the original and approves it.

- **Elements, all states:** back link "Documents"; file name; **Change type** (for Needs review and Not
  supported documents; opens a dialog to choose one of the six types) and **Delete**; Type, Status and
  Pages; the **document viewer** (every page, zoom − / + with the percentage); **Checks**, one entry per
  check with its id (A = arithmetic, D = dates, U = duplicate), a state (Passed, Failed, Skipped) and for a
  failed one the reason in words; **Fields**, each with a label, an editable value and "Confidence N%";
  **Line items** (each line a group of fields, with Add line and Delete); **History** (who uploaded,
  extracted, approved, reopened, changed the type, and when).
- **Needs review with a failed check:** the failed check shows its reason and a tick box ("Tick A3 …I
  checked it, and approve it as it is."); **Approve** is disabled until every failed check is ticked or
  corrected, with a hint line under it; **Flagged fields** come first, each with its red reason
  (failed check, "Low confidence (62%)", duplicate, currency guessed), above the unflagged **Fields**; an
  edited value shows the original ("Extracted: 120.00") beside the correction and checks update live.
- **Approved:** a banner "Approved by <name> on <date>" with **Reopen**; fields are read-only; no
  Approve button.
- **Also exists, not screenshotted:** a document whose file was deleted after 7 days (the viewer says so;
  fields and checks stay), and a not-yet-reviewable document ("It is queued, so there is nothing to review
  yet." with "Back to documents").
- **Screenshots:** needs review `documents-detail-needs-review-failed-check-desktop.png`,
  `documents-detail-needs-review-failed-check-phone.png`; approved `documents-detail-approved-desktop.png`,
  `documents-detail-approved-phone.png`

### Export `/documents/export`

- **For:** downloading approved documents of one type as XLSX (sheets "Documents" and "Line items") or
  CSV (a zip of `documents.csv` and `line_items.csv`).
- **Elements:** back link; title; description; **Type** radio list with the approved count per type (a
  type with none is disabled); once a type is chosen, a list of its approved documents, all ticked, to
  untick; **Format** radio (XLSX, CSV); **Download** (disabled until a type is chosen). The screenshot shows
  the first state, before a type is chosen.
- **Screenshots:** `documents-export-default-desktop.png`, `documents-export-default-phone.png`

### Members `/members`

- **For:** an owner managing who is in the workspace. Members see the list but no controls.
- **Elements:** title and workspace name; **Invite** button; **Members** list (name, e-mail, "(you)",
  role, and for other members a "…" menu to change role or remove; a note that the last owner cannot be
  removed); **Pending invitations** (e-mail, role, expiry, Revoke). Inviting opens a dialog "Invite someone"
  (e-mail, role Member or Owner, "Create link"); then the dialog "Invitation link" shows the link **once**
  with "Copy link" and "Done". No e-mail is sent. The link in the screenshot is a stand-in, not a real token.
- **Screenshots:** `members-owner-invitation-link-desktop.png`, `members-owner-invitation-link-phone.png`

### Billing `/billing`

- **For:** seeing the plan and pages left, and (owners only) upgrading or cancelling.
- **Elements:** title and workspace name; a notice that billing is a test-mode demonstration (test card
  4242 4242 4242 4242); **Your plan** (Current plan, Pages used this month, Pages left this month "13 of
  20"); **Upgrade** on Free, **Manage or cancel** on Pro; a note when a Pro plan ends at period end;
  **Plans** (Free, Pro). Members see the figures without the buttons.
- **Screenshots:** Free `billing-free-plan-desktop.png`, `billing-free-plan-phone.png`; Pro
  `billing-pro-plan-desktop.png`, `billing-pro-plan-phone.png`

### Invitation `/invite/[token]`

- **For:** someone who was sent an invitation link. Signed-out visitors are sent to sign-in first.
- **Elements:** card "Join a workspace" saying who they are signed in as, and **Accept invitation**.
  Refusals (not for this account, expired, already used) appear in place of the button.
- **Screenshots:** `invite-valid-invitation-desktop.png`, `invite-valid-invitation-phone.png`

### Privacy `/privacy` and Terms `/terms`

- **For:** plain legal text, a few short paragraphs, with links to the home page and the other page.
- **Screenshots:** `privacy-default-desktop.png`, `privacy-default-phone.png`, `terms-default-desktop.png`,
  `terms-default-phone.png`

### Not found (any unknown address)

- **Elements:** "Page not found", "This page does not exist or has moved.", button "Go to the home page".
  A document the user cannot open gets a similar page inside the app.
- **Screenshots:** `not-found-unknown-address-desktop.png`, `not-found-unknown-address-phone.png`

### No workspace

- **For:** a signed-in user who is in no workspace (for example after being removed from the last one).
- **Elements:** "You are not in any workspace." and the button "Create workspace" (opens a dialog asking
  for a name); the header has only Delete account and Sign out.
- **Screenshots:** `no-workspace-default-desktop.png`, `no-workspace-default-phone.png`

## 4. What must stay

- **Every field, button, check result and state** shown today: all six document types' fields and line
  items, confidence per field, flags and their reasons, the checks and their three outcomes, the seven
  statuses, the upload limits and pages-left line, the AI budget line, the plan figures, the history.
- **The wording**, unless you mark a change as a proposal ("Proposal: …") so it can be accepted or
  rejected. Several texts are fixed by requirements (7-day deletion, test-mode billing, "You are not in
  any workspace.").
- **Behaviour the layout depends on:** flagged fields come before unflagged ones; Approve stays disabled
  until every failed check is ticked; the original extracted value stays visible beside a correction;
  the document is visible next to its fields on desktop; status changes appear live in the list.
- **Keyboard use and visible focus** on every control, in a sensible tab order; dialogs and menus work
  with the keyboard and return focus.
- **Readable and usable from 360 px wide, with no horizontal page scroll.** Tables and the two-column
  review screen must reflow, not scroll sideways.
- Light theme only. Text and states must not rely on colour alone (a failed check is also worded
  "Failed").

## 5. What is free to change

Colour, type, spacing, layout, the look of every component, icons, illustration and imagery, the
header and navigation pattern, how the review screen arranges document and fields, the empty and error
states' presentation, the logo and product mark, and motion. Proposing a new visual identity is the point.

## 6. What the build can use

The app is built with Next.js (App Router), TypeScript, Tailwind CSS and shadcn/ui components (button,
card, checkbox, dialog, dropdown menu, input, label, radio group) in `src/components/ui/`, with lucide
icons. The design tokens are CSS variables in `src/app/globals.css`: `--background`, `--foreground`,
`--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--muted-foreground`, `--accent`,
`--destructive`, `--border`, `--input`, `--ring` (each with a `-foreground` pair where it has one),
`--radius`, `--font-body` and `--font-code`, mapped to Tailwind in the `@theme inline` block. Every
colour, radius and font in the app comes from these, so a design that is expressed as new values for
these tokens and as changes to the shadcn components can be built directly. Read the file in the repo
for the current values; do not guess them. A design that needs more tokens (extra colours, a type
scale) should name them.

## 7. What to hand back

A **zip of the design export** from Claude Design. The operator attaches it to a request on the
dashboard, and a worker imports it from there. Not Claude Design's Claude Code handoff.
