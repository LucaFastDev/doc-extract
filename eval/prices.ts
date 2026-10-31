// What one eval run costs, per model (issue #43 Lead ruling 2): USD per million input and output
// tokens, where each figure comes from, and the date it was checked. The runner prints the cost of
// a run, and of a --dry-run estimate, at these prices. Check them again before a run that matters,
// and update `checked` with what you found.

export interface Price {
  input_usd_per_mtok: number
  output_usd_per_mtok: number
  source: string
  /** YYYY-MM-DD. */
  checked: string
}

export const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': {
    input_usd_per_mtok: 2,
    output_usd_per_mtok: 10,
    source:
      'app_config.input_usd_per_mtok and output_usd_per_mtok as the queue milestone set them (supabase/migrations/20261031091312_extract_queue.sql), equal to Anthropic’s pricing page per docs/go-live.md',
    checked: '2026-10-31',
  },
  // The base tier, for prompts up to 100K tokens; above that it is 0.50 and 2.50. An eval request,
  // one document of at most 10 pages, is far below 100K.
  'claude-haiku-5-5': {
    input_usd_per_mtok: 0.1,
    output_usd_per_mtok: 0.5,
    source: 'Anthropic’s price table as cached 2026-10-06 in the Claude API reference, read by the Lead',
    checked: '2026-10-31',
  },
}

/** The cost in USD of the tokens at the model's price, or null when no price is recorded for it. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model]
  if (!p) return null
  return Math.round(((inputTokens * p.input_usd_per_mtok + outputTokens * p.output_usd_per_mtok) / 1e6) * 1e6) / 1e6
}
