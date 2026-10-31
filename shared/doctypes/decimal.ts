// Exact decimals for the arithmetic checks (PRD US-2.1 AC-5, US-4.1 AC-4). Amounts arrive as
// strings with their printed decimals; floating point would turn a difference of exactly 0.01 into
// 0.010000000000005 and fail a check that should pass. Plain TypeScript with no imports, so the
// browser and the Edge Functions run the same code (ARCHITECTURE.md section 3).

/** A decimal as an integer number of units at a scale: 12.50 is { units: 1250n, scale: 2 }. */
export interface Decimal {
  units: bigint
  scale: number
}

const PLAIN = /^-?\d+(\.\d+)?$/

/** A plain decimal such as "1180.00" or "-3.5"; null for anything else. */
export function parseDecimal(text: string): Decimal | null {
  const s = text.trim()
  if (!PLAIN.test(s)) return null
  const [whole, fraction = ''] = s.split('.')
  return { units: BigInt(whole + fraction), scale: fraction.length }
}

function rescale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale)
}

function aligned(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [rescale(a, scale), rescale(b, scale), scale]
}

export function add(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = aligned(a, b)
  return { units: x + y, scale }
}

export function subtract(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = aligned(a, b)
  return { units: x - y, scale }
}

export function multiply(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale }
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce(add, { units: 0n, scale: 0 })
}

/** True when a and b differ by at most the tolerance. */
export function withinTolerance(a: Decimal, b: Decimal, tolerance: Decimal): boolean {
  const diff = subtract(a, b)
  const [d, t] = aligned({ units: diff.units < 0n ? -diff.units : diff.units, scale: diff.scale }, tolerance)
  return d <= t
}

/** Rounds half away from zero to the given number of decimals. */
function round(d: Decimal, decimals: number): bigint {
  if (d.scale <= decimals) return rescale(d, decimals)
  const factor = 10n ** BigInt(d.scale - decimals)
  const negative = d.units < 0n
  const abs = negative ? -d.units : d.units
  const rounded = (abs + factor / 2n) / factor
  return negative ? -rounded : rounded
}

/**
 * For messages: grouped thousands and at least two decimals, as the PRD's example
 * "Line items sum to 1,180.00; subtotal is 1,200.00". A value printed with more decimals keeps them.
 */
export function formatAmount(d: Decimal): string {
  const decimals = Math.max(2, d.scale)
  const units = round(d, decimals)
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${whole}.${digits.slice(digits.length - decimals)}`
}

/** For messages: a quantity as printed, without padding ("3", "2.5"). */
export function formatNumber(d: Decimal): string {
  const negative = d.units < 0n
  const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, '0')
  const whole = digits.slice(0, digits.length - d.scale)
  const fraction = d.scale > 0 ? `.${digits.slice(digits.length - d.scale)}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}
