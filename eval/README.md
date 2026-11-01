# Eval set and accuracy runner

Measures field accuracy per document type (PRD F16 and section 10) on 30 fictitious documents, five
per type, with the same request and validation the app uses. The operator runs it by hand, on their
own machine with their own Anthropic key, outside the app's spend cap (OQ-26). Nothing runs it on
its own: no CI job, cron, workflow or install hook, and no test calls Claude.

## What is here

| Path | What it is |
|---|---|
| `values.ts` | What each document prints, as the app stores it; totals worked out from the lines |
| `format.ts` | How a document prints dates and numbers (`14.09.2026`, `1.234,56`) |
| `make-documents.ts` | The generator: `npm run eval:documents` rewrites `documents/` and `expected/` |
| `documents/` | The 30 documents: PDFs, and three receipts photographed as PNGs |
| `expected/` | One expected result per document: every field and line-item cell of its type |
| `score.ts` | The scoring: accuracy after normalisation, rulings 3 and 4 of issue #43 |
| `run.ts` | The runner: `npm run eval -- --model <model>` |
| `prices.ts` | USD per million tokens for each model, with the date each was checked |
| `results/` | One file per run, `<yyyy-mm-dd>-<model>.json`, committed by the operator |
| `*.test.ts` | Unit tests, run by `npm test` with a fake Claude |

Every name, address and number in the documents is invented ("Examplia" is no country). The
generator makes the same bytes on every run, and `documents.test.ts` fails if a committed file or
expected result differs from what it makes.

## Running the eval

You need Node 22.18 or later, the repo's dependencies (`npm ci`) and an Anthropic API key. The run
sends 30 requests one at a time and takes a few minutes. First check the prices in `prices.ts` against
[Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing), and update
the figures and `checked` if they changed.

### macOS (Terminal, zsh or bash)

```sh
npm ci
export ANTHROPIC_API_KEY='sk-ant-…'           # your own key; it stays in this shell only
npm run eval -- --dry-run                       # optional: builds the requests, prints the estimate, sends nothing
npm run eval -- --model claude-sonnet-5-5
npm run eval -- --model claude-haiku-5-5
unset ANTHROPIC_API_KEY
git add eval/results/
git commit -m "Eval results for claude-sonnet-5-5 and claude-haiku-5-5"
```

### Windows (PowerShell)

```powershell
npm ci
$env:ANTHROPIC_API_KEY = 'sk-ant-…'            # your own key; it stays in this window only
npm run eval -- --dry-run
npm run eval -- --model claude-sonnet-5-5
npm run eval -- --model claude-haiku-5-5
Remove-Item Env:ANTHROPIC_API_KEY
git add eval/results/
git commit -m "Eval results for claude-sonnet-5-5 and claude-haiku-5-5"
```

If PowerShell drops the `--`, npm keeps `--model` for itself; the runner then stops with a message
saying so instead of running the default model. Run the same file without npm instead:
`node --experimental-transform-types eval/run.ts --model claude-haiku-5-5`.

`--model` defaults to `claude-sonnet-5-5`. Each run writes
`eval/results/<yyyy-mm-dd>-<model>.json` (UTC date); a second run on the same day with the same
model replaces it. The runner always calls `https://api.anthropic.com`, whatever
`ANTHROPIC_BASE_URL` says, so a local functions setting cannot point it at the mock server. A
Node warning that "Transform Types is an experimental feature" is expected: the runner imports the
app's own Claude client, which needs it.

ARCHITECTURE.md section 9: if Haiku meets the targets, it becomes the default model. That choice,
and any change to `app_config`, is made separately, from the committed results. Until then,
`app_config.base_input_tokens` (20000) comes from the dry run's estimate of the fixed part of a
request, about 18,000 tokens.

### What a run costs

From the runner's own estimate (`npm run eval -- --dry-run`) on 2026-10-31, at the prices in
`prices.ts`, one run of the 30 documents is about **639,700 input and 25,400 output tokens**:

| Model | Input, USD per MTok | Output, USD per MTok | One run |
|---|---|---|---|
| `claude-sonnet-5-5` | 2 | 10 | about USD 1.53 |
| `claude-haiku-5-5` | 0.10 | 0.50 | about USD 0.08 |

The estimate errs high: it counts 3.5 characters per token for the system prompt and the tool
definitions (about 18,000 tokens per request, sent with every document) and 3,000 tokens per PDF
page. Retries after a 429, a 529 or an invalid answer add to it. The run prints the real token
counts and cost at the end and records them in the results file.

## How it scores

For each document the runner sends the request the app sends (`buildRequest` with every type's tool
and `record_not_supported`, so the type is detected; `temperature` 0, `max_tokens` 8192), validates
the answer as the app does before storing it (`prepareResult`, with `app_config`'s confidence
threshold 0.8 and tolerance 0.01), and compares the stored values with `expected/`:

- **Accuracy** per type, header fields and line-item cells apart: the share of expected values the
  extraction returns exactly after normalisation (dates as `YYYY-MM-DD`, amounts and numbers as exact
  decimals so `18.9` equals `18.90`, text with case and surrounding whitespace ignored). An empty
  expected value is right only when the extraction is empty too.
- **Line items match by position**: expected row i against extracted row i. The cells of a missing
  row are misses; an extra row is listed, not scored.
- A document whose **type is detected wrong**, that calls `record_not_supported`, or that **fails**
  (a retryable error three times, an invalid answer twice, or a fatal error) scores every expected
  value as a miss and is listed.
- **Confidence is not scored**: it is recorded per field, with the count of misses at or above 0.8.
- **Check usefulness**: every total or subtotal the model misread (an invoice's, receipt's,
  purchase order's or quote's `subtotal` and `total`, a bank statement's `closing_balance`,
  `total_credits` and `total_debits`, a delivery note's `total_quantity`), and whether an
  arithmetic check flagged it. `checks.test.ts` seeds such a misread in every expected result and
  asserts a check flags it.

## The results file

`results/<yyyy-mm-dd>-<model>.json`; the landing page (milestone 12) reads the latest one.

```jsonc
{
  "date": "2026-11-02",                 // the run's UTC date
  "model": "claude-sonnet-5-5",
  "prompt_version": "2026-10-31.2",     // PROMPT_VERSION in supabase/functions/_shared/claude.ts
  "settings": { "max_tokens": 8192, "temperature": 0, "confidence_threshold": 0.8, "amount_tolerance": "0.01", "attempts": 3 },
  "types": {                            // one entry per type: invoice, receipt, bank_statement,
    "invoice": {                        // purchase_order, delivery_note, quote
      "documents": 5,
      "header":     { "correct": 101, "total": 105, "accuracy": 0.9619, "target": 0.95, "meets_target": true },
      "line_items": { "correct": 300, "total": 308, "accuracy": 0.974,  "target": 0.9,  "meets_target": true },
      "type_detection": { "correct": 5, "total": 5 }
    }
  },
  "check_usefulness": {
    "misread_totals": [
      { "document": "quote-02.pdf", "path": "total", "expected": "4372.48", "got": "4327.48", "flagged": true, "checks": ["A3"] }
    ],
    "misread": 1,                       // misread totals and subtotals
    "flagged": 1                        // of them, flagged check_failed by an arithmetic check
  },
  "usage": {
    "input_tokens": 612345,
    "output_tokens": 24012,
    "max_input_tokens_per_page": 20512, // the largest input_tokens ÷ pages of any answer
    "cost_usd": 1.464802,               // at prices.ts's prices; null for a model it has none for
    "prices_checked": "2026-10-31"
  },
  "failed_documents": [],               // the documents that failed, by file name
  "documents": [                        // one per document, in the order sent
    {
      "document": "invoice-01.pdf",
      "doc_type": "invoice",            // the expected type
      "outcome": "ok",                  // ok, not_supported or failed
      "detected_type": "invoice",       // the tool Claude called; null when the document failed
      "type_correct": true,
      "error": "…",                     // only for a failed document
      "header": { "correct": 21, "total": 21 },
      "line_items": { "correct": 28, "total": 28 },
      "misses": [{ "path": "line_items[2].unit", "expected": "pcs", "got": "pc", "confidence": 0.9 }],
      "confident_misses": 1,            // misses with confidence at or above 0.8
      "confidence": { "vendor_name": 0.99, "line_items[0].amount": 0.98 },
      "extra_line_items": [{ "index": 4, "values": { "description": "Delivery" } }],
      "pages": 1,
      "usage": { "input_tokens": 20113, "output_tokens": 812, "attempts": 1 }
    }
  ]
}
```

`accuracy` is null, and `meets_target` with it, for a type with no values of that kind. The
targets are PRD section 10's; missing one does not block a release (OQ-32).

`max_input_tokens_per_page` divides a whole request's input by its pages, so it includes the fixed
part every request carries (system prompt and tool definitions). Setting
`app_config.max_input_tokens_per_page` at or above it keeps the spend estimate an upper bound
(ARCHITECTURE.md section 7), with room to spare on multi-page documents.

## Changing the eval set

Edit `values.ts` (or the layouts in `make-documents.ts`), run `npm run eval:documents`, look at the
changed documents, and run `npm test`. The tests check that every expected value is printed in its
document, that each expected result is what the app's validation stores, and that every total adds
up. A changed prompt, schema or check needs no change here; `PROMPT_VERSION` in each results file
tells the runs apart.
