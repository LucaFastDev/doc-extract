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

doc-extract reads business documents (PDFs, phone photos, scans) with Claude and returns structured
data: header fields, line items and a confidence for every field. It then **checks** the result
(arithmetic, dates, duplicates) and puts anything doubtful in front of a person first. A person
approves the result, and approved results export to CSV or XLSX.

- **Users:** small businesses, bookkeepers and freelancers who now retype documents into spreadsheets.
  They work in English; their documents can be in any language and currency.
- **Visitors:** people arriving from the operator's portfolio. They must see the product working in one
  click, without signing up.
- **Workspaces:** documents live in workspaces shared by a few people, with the roles owner and member.

## 3. Pages

File names below are in `screenshots/`; each has a `-desktop.png` (1440×900 viewport) and a
`-phone.png` (390×844 viewport) version, full page height.

Messages are quoted word for word from the app. A word in square brackets, such as [file], is filled in
by the app. The menus, dialogs, refusals and failure messages described below are not in the screenshots
except where named; design them in the same system. The app has no error page of its own: a page whose
data cannot be read when it loads has no wording from this app.

### Shared header (every signed-in page)

- **For:** moving between workspaces and reaching the account actions. It tops the document list, the
  review screen, export, members, billing and the no-workspace page. The demo has a small header of its
  own; the landing, sign-in, invitation, privacy, terms and not-found pages have no header.
- **Does:** goes to the document list through the product name; switches workspace; opens Members or
  Billing; creates a workspace; an owner of the current workspace renames or deletes it; deletes their
  own account; signs out, which leads to the landing page.
- **Elements:** the product name "doc-extract" (a link to the document list); the **workspace switcher**,
  a button showing the current workspace's name; **Delete account**; **Sign out**. A user in no workspace
  has no switcher.
- **Switcher menu:** the heading "Workspaces" and the user's workspaces, the current one marked; then
  **Members**, **Billing** and **Create workspace** for everyone; then, only for an owner of the current
  workspace, **Rename workspace** and **Delete workspace** (shown as destructive). The switcher is
  disabled while a switch runs. A failed switch or sign-out has no message of its own.
- **Create workspace dialog:** title "Create workspace"; "You will be its owner, and it opens once
  created."; field "Name"; button "Create". Refusals under the field: "Enter a name for the workspace.",
  "Use 100 characters or fewer for the workspace name.", "The workspace could not be created. Try again."
- **Rename workspace dialog (owner):** title "Rename workspace"; "Every member sees the new name."; field
  "Name" holding the current name; button "Save". Refusals under the field: "Enter a name for the
  workspace.", "Use 100 characters or fewer for the workspace name.", "The workspace could not be
  renamed. Try again.", "Only an owner can rename this workspace."
- **Delete workspace dialog (owner):** title "Delete workspace"; "This deletes [workspace] for everyone:
  its documents, files, results, history, invitations and members. An active Pro subscription is cancelled
  at once. This cannot be undone."; field "Type [workspace] to confirm"; buttons "Cancel" and "Delete
  workspace", the second disabled until the name is typed exactly. Failure: "This could not be deleted.
  Try again." The dialog cannot be closed while the deletion runs. Success opens the document list of
  another workspace, or the no-workspace page.
- **Delete account dialog:** title "Delete your account"; "This deletes your account and cannot be undone.
  You leave every workspace you share; documents you uploaded there stay, shown as uploaded by a deleted
  user."; buttons "Cancel" and "Delete my account", the second disabled while the workspaces are read. When
  workspaces go with the account it adds "These workspaces have no other members and are deleted with all
  their data: [names]." If they cannot be read: "Couldn't load your workspaces. Try again." and only
  Cancel stays. Refusal after pressing the button: "You are the only owner of [names], which still have
  other members. Make another member an owner of each, or delete it first." Failure: "This could not be
  deleted. Try again." The dialog cannot be closed while the deletion runs. Success opens the landing page.
- **Screenshots:** the header is in every signed-in page's screenshots; its menu and dialogs are in none.

### Landing page `/`

- **For:** a first-time visitor deciding whether to try it. A signed-in visitor sees the same page.
- **Does:** reads what it is, opens the demo, signs in, or follows a footer link.
- **Elements:** headline "Business documents in, checked data out"; intro paragraph; primary button
  "Try the demo" with "No sign-up. Sample documents, nothing saved."; secondary button "Sign in"; "How it
  works" (three steps: Upload, Check, Approve and export); "Six document types"; "Measured accuracy" (a
  sentence on how it is measured, then "The first accuracy run has not been published yet.", as in the
  screenshots; once results are published, one table per model with the columns Document type, Header
  fields, Line items and Target, one row per type, and under it "Run on [date] with [model]."); "Plans"
  (Free: 20 pages a month per workspace, $0; Pro: 500 pages a month per workspace, $19 a month) with three
  notes (Stripe test mode, 10 pages per account, files deleted after 7 days); footer links Source code,
  Privacy, Terms. (A portfolio link also appears in the footer when configured; it is not configured in the
  screenshots.)
- **Screenshots:** `landing-signed-out-desktop.png`, `landing-signed-out-phone.png`

### Sign-in `/sign-in`

- **For:** getting into the app. Google is the only way in: no password, no e-mail form. A visitor who is
  already signed in goes straight on to the page they asked for.
- **Does:** presses "Continue with Google", which leaves for Google and comes back to the page they first
  asked for, or to the document list; or follows the Privacy and Terms links. Nothing else.
- **Elements:** card "Sign in to doc-extract" with the two sentences "Use your Google account. A personal
  workspace is made for you on first sign-in." and the button "Continue with Google", disabled while
  Google is being opened; Privacy and Terms links.
- **Failures:** "Sign-in did not complete. Try again." above the button, on coming back from Google
  without a session. "Google sign-in could not start. Try again." under the button, which works again.
- **Screenshots:** `sign-in-default-desktop.png`, `sign-in-default-phone.png`

### Demo: sample list `/demo`

- **For:** trying the product without an account. Nothing is saved and no AI is called.
- **Does:** reads the seven samples and opens one, or signs in to use their own documents. A signed-in
  visitor goes to their documents instead.
- **Elements:** a header with the links "doc-extract" (to the landing page) and "Demo" (to this page);
  title "Try doc-extract on sample documents" and explanation; seven sample cards, each with a title,
  document type and page count, a one-line summary of what it shows (a failed total, a duplicate, low
  confidence, a date error, and so on) and an arrow; a "Your own documents" panel. Signed out, the panel
  says "Uploading your own needs an account, with up to 10 pages per account. Sign in with Google to make
  one." with the button "Sign in with Google". Signed in, it says "You are signed in: upload your own
  documents from your document list." with the button "Go to your documents".
- **Failures:** "Google sign-in could not start. Try again." under the sign-in button. The list has no
  empty message of its own.
- **Screenshots:** `demo-sample-list-desktop.png`, `demo-sample-list-phone.png`

### Demo: a sample with a failed check `/demo/invoice-total-mismatch`

- **For:** showing the whole review screen on a PDF invoice whose printed total is wrong.
- **Does:** compares the values with the pages, reads the failed check, ticks it, edits fields and line
  items, chooses a format and downloads the sample as edited. Nothing is saved: a reload shows the stored
  result again.
- **Elements:** back link "Samples"; file name; Type and Pages; the document viewer (all pages, zoom
  − / +); **Checks** list (A3 Failed with its explanation and a "Tick A3" tick box, A4 Skipped with "Skipped:
  no amount paid is printed.", the rest Passed); **Export** ("The sample with your corrections, as an
  approved document would be exported.", XLSX or CSV radio choice and Download); **Flagged fields** (each
  flagged field with its reason, editable value and confidence); **Fields**; **Line items** with Add line and
  Delete per line. The review screen is described fully under `/documents/[id]`; the demo has Export in
  place of Approve, and has no Status, Change type, Delete, Reopen or History.
- **Failures:** "The export could not be made. Try again." under Download; the viewer's states as under
  `/documents/[id]`. An unknown sample's address gets the not-found page.
- **Screenshots:** `demo-invoice-total-mismatch-failed-check-desktop.png`,
  `demo-invoice-total-mismatch-failed-check-phone.png`

### Demo: a photographed document `/demo/receipt-photo`

- **For:** showing an image document (a photographed till receipt) with low-confidence fields.
- **Does:** compares the photo with the values, edits the two flagged fields or any other value, and
  downloads it as above. Nothing is saved.
- **Elements:** same screen; the viewer shows a photo instead of PDF pages; two fields flagged "Low
  confidence (58%)" and "Low confidence (66%)"; every check passes, so there is no tick box.
- **Failures:** as for the sample above.
- **Screenshots:** `demo-receipt-photo-image-document-desktop.png`,
  `demo-receipt-photo-image-document-phone.png`

### Document list `/documents`

The home of a signed-in user. Three screenshots show its states. Owners and members see the same page.

- **Does:** uploads files, sees each document's status change live, opens a document to review it,
  retries a failed one, deletes a document, and goes to Export.
- **Elements:** title "Documents"; "Export" button; **upload area** (drop zone with the limits text "Drop
  up to 10 files here, or choose them. PDF, JPEG, PNG or WebP. PDFs at most 10 MB, images at most 7.5 MB,
  and 10 pages each.", "Choose files" button, "Files are deleted 7 days after upload.", the pages-left line
  "[n] of your account’s 10 pages left · [n] of this workspace’s 20 pages left this month", whose first part
  is absent when the account limit is off, and the AI budget line "$3.40 of $10 used this month"); then
  either the empty message "No documents in [workspace] yet." or the table.
- **Upload area, other states:** a drag-over state of the drop zone. While uploading, "Uploading [n] of
  [total]…", with Choose files disabled and drops ignored. "Couldn't update pages left. Reload the page to
  see the current count." when the line could not be refreshed after an upload. The budget line adds, while
  a limit is reached, "Today's AI limit is reached. Waiting documents resume at [time]." or "This month's AI
  limit is reached. Waiting documents resume on [date]."; it is hidden when the budget cannot be read.
- **Upload refused before anything is uploaded,** one or a list, always ending "Nothing was uploaded.":
  "Choose at least one file.", "You can upload at most 10 files at once.", "[file] is not a PDF, JPEG, PNG or
  WebP file. Accepted types: PDF, JPEG, PNG and WebP.", "[file] is over the 7.5 MB limit for images.", "[file]
  is over the 10 MB limit.", "[file] is empty."
- **Upload refused for one file,** while the others go on, one or a list, without that ending: "[file] is not
  a PDF, JPEG, PNG or WebP file, or its content does not match its type. Accepted types: PDF, JPEG, PNG and
  WebP.", "[file] is over the 7.5 MB limit for images.", "[file] could not be read as a PDF.", "[file] has [n]
  pages. A document can have at most 10 pages.", "[file] has [n] pages, but only [m] pages remain of your page
  allowance (this workspace’s monthly allowance and your account’s 10-page limit).", or, with the account
  limit off, "[file] has [n] pages, but only [m] pages remain of this workspace’s monthly page allowance.",
  "[file] did not finish uploading. Upload it again.", "[file] could not be queued for extraction. Upload it
  again.", "The upload could not be submitted. Try again.", "Sign in to upload documents.", "No such
  document.", "You are not a member of this workspace.", and any other failure as "[file] could not be
  uploaded: [reason]. Try again." or "[file] could not be uploaded. Try again."
- **Table:** the columns Name, Type, Status and Pages, with a delete (trash) button in each row's Pages cell.
  Type and Pages stay blank until they are known. Statuses: **Queued**, **Processing**, **Waiting for budget**
  (with a reason), **Needs review**, **Approved**, **Failed** (with a reason and a Retry button) and **Not
  supported** (with a reason). Rows change status live, without reload, with no visible indicator. Names of
  documents that can be opened (Needs review, Approved, Not supported) are links; the others are plain text.
- **Reasons in the table:** Waiting for budget: "The daily AI spending limit is reached. It resets at 00:00 UTC
  on [date], when processing resumes." or the same with "monthly". Not supported: "Not a supported document
  type: [Claude's reason]" Failed: "Extraction failed 3 times. The last time, [reason] Retry later.", where
  the reason is a sentence such as "Claude was overloaded.", "Claude’s rate limit was reached.", "Claude had a
  server error.", "Claude did not answer in time.", "Claude could not be reached.", "the file could not be read
  from Storage.", "the run did not finish.", "Claude’s answer was cut off." or another saying what was wrong
  with Claude's answer; or, on its own, "Claude could not read this file. It may be damaged, password-protected
  or too large.", "Claude declined to read this document.", "Claude refused the request (status [n]).", "The
  file was deleted before it could be read.", "Claude’s answer did not have the expected form, twice. Retry
  later."
- **Retry:** the button is there only while the file still exists; it is disabled while the retry starts, and
  the row then changes live. Refusals above the table: "[file] could not be retried. Try again.", "[file]
  cannot be retried: its file has been deleted.", "Only a failed document can be retried.", "[file] has [n]
  pages, but only [m] pages remain of the page allowance (the workspace’s pages this month and the uploader’s
  lifetime cap).", or, when the uploader's account is gone, "[file] has [n] pages, but only [m] pages remain of
  the workspace’s pages this month."
- **Delete dialog:** title "Delete [file]?"; "Its file, fields, corrections, check results and history are
  deleted for everyone in the workspace. Pages it used are not given back."; buttons "Cancel" and "Delete".
  Refusals in the dialog: "[file] could not be deleted. Try again.", "The document could not be deleted. Try
  again.", "This document does not exist.", "Sign in to delete documents."
- **Screenshots:**
  - Empty workspace: `documents-empty-workspace-desktop.png`, `documents-empty-workspace-phone.png`
  - A list with a document in every status: `documents-list-all-statuses-desktop.png`,
    `documents-list-all-statuses-phone.png`
  - Upload area with pages left and the budget line, above a short list:
    `documents-upload-area-pages-left-and-budget-desktop.png`,
    `documents-upload-area-pages-left-and-budget-phone.png`

### Review screen `/documents/[id]`

The most important screen: a person checks what was read against the original and approves it.

- **Does:** compares each value with the document, corrects values (each saved on leaving its field), adds
  or deletes line items, ticks failed checks they accept, approves (or reopens an approved document), changes
  the type, deletes. Any member can do all of it; no control here depends on the role.
- **Elements, all states:** back link "Documents"; file name; **Change type** (for Needs review and Not
  supported documents whose file still exists; opens a dialog to choose one of the six types) and **Delete**;
  Type (or "None"), Status and Pages; the **document viewer** (every page or the image, zoom − / + with the
  percentage, from 50% to 300%, "Loading the document…" while a PDF is drawn, and "The document could not be
  shown. Reload the page to try again." when it cannot be); **Checks**, failed first, then skipped, then passed,
  one entry per check with its id (A = arithmetic, D = dates, U = duplicate), a state (Passed, Failed, Skipped)
  and for a failed or skipped one the reason in words ("Skipped: no amount paid is printed."); **Fields**, each
  with a label, an editable value and "Confidence [n]%" ("Confidence —" in a line the person added); **Line items**
  (**Transactions** on a bank statement), each line a group of fields headed "Line [n]" or "Transaction [n]",
  with "Add line" or "Add transaction", and Delete, "None." when there are none, and "Its flagged cells are
  listed under Flagged fields." on a line that has some; **History**, newest first, each entry "[event] by [name]
  · [time]" with the events Uploaded, Extracted, Approved, Reopened, Type changed and Retried, the name being
  Claude for an extraction, "a member" or "a deleted user" where no name can be shown.
- **Needs review with a failed check:** the failed check shows its reason and a tick box ("Tick A3" and "I
  checked it, and approve it as it is."); **Approve** is disabled until every failed check is ticked or
  corrected, with a hint line under it ("Tick A3 to approve, or correct the fields until it passes.", or with
  several, "Tick A1 and A3 to approve, or correct the fields until they pass."); **Flagged fields** come first,
  each with its reasons ("A3: [the check's message]", "Low confidence (62%)", "U1: Duplicate of "[file]": the
  same [fields]." or "U1: Duplicate of "[file]": the same file was uploaded before.", "Currency guessed: only
  “[symbol]” is printed, which several currencies use", "Currency guessed: no currency is printed"), above the
  unflagged **Fields**; an edited value shows the original ("Extracted: 120.00", or "Extracted: empty") beside
  the correction and checks update live. While the person is in a field, the sections keep their places, and
  they sort again once the focus has left the fields.
- **Approved:** a banner "Approved by [name] on [time]" ([name] may be "a member" or "a deleted user") with
  **Reopen**; fields are read-only, an empty one showing "—"; no Approve, Add line, line Delete or Change type; a failed check's tick box stays, disabled.
  The document's Delete stays.
- **Not supported:** the viewer and History stay. In place of Checks and Fields, one panel: the reason ("Not a
  supported document type: [Claude's reason]", or "This is not a supported document type."), then "If it is one
  of the six types, change its type to extract it again as that type.", or, once the file is gone, "Its file has
  been deleted, so its type can no longer be changed."
- **File deleted after 7 days:** in place of the viewer, "The file was deleted 7 days after upload, on [time].
  Its fields, checks and history are kept."; no Change type.
- **Not reviewable:** a Queued, Processing, Waiting for budget or Failed document is reached only by its address:
  the file name, "It is [status], so there is nothing to review yet.", as in "It is queued, so there is nothing to
  review yet.", and the button "Back to documents".
- **Not found:** a document that does not exist, was deleted or is in another workspace, inside the shared
  header: "This document does not exist", "It may have been deleted, or it is in a workspace you are not a member
  of.", button "Back to documents".
- **Change type dialog:** title "Change the type of [file]"; for a Needs review document "Its fields, corrections
  and ticked checks are discarded, and it is extracted again as the type you choose. No further pages are
  counted.", for a Not supported one "It is extracted again as the type you choose. Its pages are held again, and
  count once the extraction succeeds."; a radio list of the six types; buttons "Cancel" and "Change type and
  extract again", the second disabled until a type is chosen. Success opens the document list. Refusals in the
  dialog: "The type of [file] could not be changed. Try again.", "[file] cannot change type: its file has been
  deleted.", "Only a document that needs review or is not supported can change type.", and the same two allowance
  refusals as Retry on the document list.
- **Delete dialog:** as on the document list; success opens the document list.
- **Refusals at the top of the screen,** after which the stored values come back: "[field] could not be saved. Try
  again.", "[field] could not be saved: the document no longer needs review.", "That change could not be saved.
  Reload the page and try again.", "The line could not be added. Try again.", "The line could not be deleted. Try
  again.", "Line items can be added only while the document needs review.", "Line items can be deleted only while
  the document needs review.", "There is no line [n] to add a line after.", "There is no line [n] to delete.",
  "[check] could not be ticked. Try again.", "Checks can be ticked only while the document needs review.", "The
  document has no check [check].", "[file] could not be approved. Try again.", "The document could not be
  approved. Try again.", "Tick the failed check A3 before approving.", or with several, "Tick the failed checks A1
  and A3 before approving.", "[file] changed while it was being approved. Try again.", "[file] cannot be approved:
  it does not need review.", "This document does not exist.", "Sign in to approve documents.", "[file] could not
  be reopened. Try again.", "Only an approved document can be reopened."
- **Screenshots:** needs review `documents-detail-needs-review-failed-check-desktop.png`,
  `documents-detail-needs-review-failed-check-phone.png`; approved `documents-detail-approved-desktop.png`,
  `documents-detail-approved-phone.png`
- **Known gap in the approved screenshots:** their History shows no "approved" entry, because that
  state was set up through the database. A real approval writes one (who and when), so the design must
  still show it.

### Export `/documents/export`

- **For:** downloading approved documents of one type as XLSX (sheets "Documents" and "Line items") or
  CSV (a zip of `documents.csv` and `line_items.csv`). Owners and members see the same page.
- **Does:** chooses a type, unticks documents to leave out or uses Select all and Select none, chooses a
  format, and downloads.
- **Elements:** back link "Documents"; title "Export"; "Approved documents of one type in [workspace], with
  corrected values where there are any."; **Type** radio list of the six types, each with "[n] approved" (a type
  with none is disabled); once a type is chosen, **Documents**, with "Select all" and "Select none", its approved
  documents, all ticked, to untick, each with "Approved [time]", and "[n] of [m] ticked"; **Format** radio (XLSX,
  chosen at first, "one file with the sheets Documents and Line items"; CSV, "a zip of documents.csv and
  line_items.csv"); **Download** (disabled until a type is chosen and a document is ticked). The screenshot shows
  the first state, before a type is chosen.
- **States and failures:** "Loading approved documents…" while they load. "The approved documents could not be
  loaded. Reload the page to try again." in place of the steps. "No document is approved yet. Approve documents on
  their review screen." under Type. "Preparing the file…" while the file is made. Under Download: "None of the
  ticked documents is still approved. Reload the page to see the current list.", "The export could not be made.
  Try again.", and, with the file still downloaded, "1 of the ticked documents is no longer approved and was left
  out." or "[n] of the ticked documents are no longer approved and were left out."
- **Screenshots:** `documents-export-default-desktop.png`, `documents-export-default-phone.png`

### Members `/members`

- **For:** an owner managing who is in the workspace. Members see only the people and their roles, with no
  controls and no invitations.
- **Does:** an owner invites someone and copies the link, changes a member's role, removes a member, or
  revokes an invitation. A member only reads the list.
- **Elements:** title "Members" and "People in [workspace]."; **Invite** button (owner only); **Members** list
  (name, or "Unknown user" when there is none, e-mail when it differs from the name, "(you)", role); for an owner, a "…" menu on every row but the only
  owner's, with "Make owner" or "Make member", and "Remove from workspace"; for an owner, on the only owner's row,
  "The only owner cannot be removed or made a member: a workspace needs at least one owner."; **Pending
  invitations** (owner only): e-mail, "[role] · expires [date]" and Revoke per invitation, or "No pending
  invitations."
- **Invite someone dialog:** title "Invite someone"; "You get a link for one email address. They join by opening
  it signed in with Google as that address."; field "Email address"; radio "Role", Member (chosen at first,
  "Uploads, reviews, approves and exports documents.") or Owner ("Also invites people, manages members and billing,
  and renames the workspace."); button "Create link". Refusals under the field: "Enter an email address.", "Choose
  a role.", "Enter a valid email address.", "Only an owner can invite people to this workspace.", "The invitation
  could not be created. Try again."
- **Invitation link dialog:** title "Invitation link"; "Send this link to [email] yourself: no email is sent. It
  works for 7 days, once, and only for that address. It is shown only now."; field "Link" with the link, shown
  **once**; buttons "Done" and "Copy link", which becomes "Copied" with "Link copied.", or on failure shows "Copying
  did not work. The link is selected: copy it from there." No e-mail is sent. The link in the screenshot is a
  stand-in, not a real token.
- **Remove dialog:** title "Remove [name]?"; "They lose access to [workspace] at once. Documents they uploaded stay
  in the workspace."; buttons "Cancel" and "Remove".
- **Refusals:** above the Members list: "A workspace needs at least one owner. Make another member an owner first.",
  "Only an owner can change members.", "They are no longer a member of this workspace.", "The change could not be
  saved. Try again." Above the invitations: "This invitation is no longer pending, or only an owner can revoke it."
- **Screenshots:** `members-owner-invitation-link-desktop.png`, `members-owner-invitation-link-phone.png`

### Billing `/billing`

- **For:** seeing the plan and pages left, and (owners only) upgrading or cancelling.
- **Does:** reads the plan and pages used and left; an owner upgrades to Pro or manages or cancels it, both on
  Stripe's own pages, and comes back here. A member can only read.
- **Elements:** title "Billing" and "The plan and pages of [workspace]."; the notice, for owners and members:
  "Billing here is a test-mode demonstration. Only Stripe test cards are accepted and no real money is ever charged.
  To try it, use the card 4242 4242 4242 4242 with any future date and any CVC."; **Your plan** (Current plan, Pages
  used this month, Pages left this month "13 of 20"); **Upgrade** on Free, **Manage or cancel** on Pro (owners only;
  members see the figures without the buttons); "Your Pro plan ends on [date]." when a Pro plan ends at period end;
  **Plans** (Free, Pro, each "[n] pages a month per workspace" and its price).
- **Back from paying (owner only):** "Checking your plan…" with Upgrade disabled, until the plan shows Pro, or after
  20 seconds "Your payment went through. Your plan will update shortly."
- **Failures,** under the figures: "That did not work. Check your connection and try again.", "Checkout could not be
  opened. Try again.", "The customer portal could not be opened. Try again.", "This workspace is already on Pro.",
  "This workspace has no Stripe customer yet.", "Only an owner of this workspace can manage billing.", "Sign in to
  manage billing."
- **Screenshots:** Free `billing-free-plan-desktop.png`, `billing-free-plan-phone.png`; Pro
  `billing-pro-plan-desktop.png`, `billing-pro-plan-phone.png`

### Invitation `/invite/[token]`

- **For:** someone who was sent an invitation link. Signed-out visitors are sent to sign-in first and come back
  here. The page has no header.
- **Does:** accepts the invitation, and lands on the document list of that workspace. When it is refused, reads why
  and goes to their own documents with the one button; when it could not be accepted, presses Accept invitation again.
- **Elements:** card "Join a workspace" with "You have been invited to a workspace on doc-extract. Accepting adds you
  with the role its owner chose. You are signed in as [email]." and **Accept invitation**, disabled while it runs.
- **Refusals in place of Accept invitation, with the button "Go to your documents":** "This invitation is not for
  you: it was made for another email address. Sign in with the Google account it was sent to.", "This invitation is
  no longer valid: it has expired, been used or been revoked. Ask the owner for a new link.", which a link that was
  never valid gets too, and "You are already a member of this workspace."
- **Failure above Accept invitation, which stays:** "The invitation could not be accepted. Try again."
- **Screenshots:** `invite-valid-invitation-desktop.png`, `invite-valid-invitation-phone.png`

### Privacy `/privacy` and Terms `/terms`

- **For:** plain legal text, a few short paragraphs, with the links "doc-extract home" and the other page ("Terms" on
  Privacy, "Privacy" on Terms).
- **Does:** reads, and follows the links. Nothing else.
- **Screenshots:** `privacy-default-desktop.png`, `privacy-default-phone.png`, `terms-default-desktop.png`,
  `terms-default-phone.png`

### Not found (any unknown address)

- **Does:** goes to the home page with the one button. Nothing else.
- **Elements:** "Page not found", "This page does not exist or has moved.", button "Go to the home page". The same
  for signed-in and signed-out visitors, with no header. A signed-out visitor on a signed-in page is sent to sign-in
  instead. A document the user cannot open gets its own page inside the app (see the review screen's Not found).
- **Screenshots:** `not-found-unknown-address-desktop.png`, `not-found-unknown-address-phone.png`

### No workspace

- **For:** a signed-in user who is in no workspace (for example after being removed from the last one). It takes the
  place of every signed-in page for them.
- **Does:** creates a workspace by giving it a name, or deletes their account or signs out from the
  header. Nothing else.
- **Elements:** "You are not in any workspace." and the button "Create workspace", which opens the Create workspace
  dialog with its refusals (see the shared header); the header has the product name, Delete account and Sign out, and
  no switcher.
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
