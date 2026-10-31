// The currency rule (PRD US-7.1 AC-5, OQ-16): the currency is a guess, and its field is flagged
// currency_guessed, when the document prints none, or prints only a symbol that several
// currencies use. A delivery note has no amounts and is never flagged (index.ts).

/** Symbols that stand for more than one currency, compared without case. */
export const AMBIGUOUS_CURRENCY_SYMBOLS = ['$', 'kr', 'kr.', '¥', '￥', 'Fr', 'Fr.', 'Rs', 'Rs.', '₨', '﷼'] as const

const AMBIGUOUS = new Set(AMBIGUOUS_CURRENCY_SYMBOLS.map((s) => s.toLowerCase()))

/** True when currency_as_printed names no one currency, so the ISO code was read from context. */
export function currencyGuessed(asPrinted: string | null | undefined): boolean {
  const printed = asPrinted?.trim() ?? ''
  return printed === '' || AMBIGUOUS.has(printed.toLowerCase())
}
