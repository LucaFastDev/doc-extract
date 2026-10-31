import { describe, expect, it } from 'vitest'
import { add, formatAmount, formatNumber, multiply, parseDecimal, subtract, sum, withinTolerance } from './decimal'

// Exact decimal arithmetic for the checks (PRD US-2.1 AC-5, US-4.1 AC-4, OQ-7).

const d = (s: string) => {
  const value = parseDecimal(s)
  if (!value) throw new Error(`not a decimal: ${s}`)
  return value
}

describe('parseDecimal', () => {
  it('reads plain decimals, keeping their printed decimals', () => {
    expect(parseDecimal('1180.00')).toEqual({ units: 118000n, scale: 2 })
    expect(parseDecimal(' -3.5 ')).toEqual({ units: -35n, scale: 1 })
    expect(parseDecimal('42')).toEqual({ units: 42n, scale: 0 })
  })

  it('refuses anything that is not a plain decimal', () => {
    for (const s of ['', '1,180.00', '€12', '1.2.3', '1e3', 'abc', '.5', '5.']) {
      expect(parseDecimal(s), s).toBeNull()
    }
  })
})

describe('arithmetic', () => {
  it('adds, subtracts, multiplies and sums exactly', () => {
    expect(formatAmount(add(d('0.1'), d('0.2')))).toBe('0.30')
    expect(formatAmount(subtract(d('1200'), d('20.005')))).toBe('1,179.995')
    expect(formatAmount(multiply(d('3'), d('19.99')))).toBe('59.97')
    expect(formatAmount(sum([d('100.10'), d('200.20'), d('0.7')]))).toBe('301.00')
    expect(formatAmount(sum([]))).toBe('0.00')
  })
})

describe('withinTolerance', () => {
  it('accepts a difference of exactly the tolerance, and refuses one just over it', () => {
    expect(withinTolerance(d('100.01'), d('100.00'), d('0.01'))).toBe(true)
    expect(withinTolerance(d('100.00'), d('100.01'), d('0.01'))).toBe(true)
    expect(withinTolerance(d('100.011'), d('100.00'), d('0.01'))).toBe(false)
    expect(withinTolerance(d('1000'), d('1001'), d('1'))).toBe(true)
    expect(withinTolerance(d('1000'), d('1002'), d('1'))).toBe(false)
  })
})

describe('formatting', () => {
  it('groups thousands and shows at least two decimals', () => {
    expect(formatAmount(d('1180'))).toBe('1,180.00')
    expect(formatAmount(d('1234567.5'))).toBe('1,234,567.50')
    expect(formatAmount(d('-0.5'))).toBe('-0.50')
  })

  it('prints a quantity as it is', () => {
    expect(formatNumber(d('3'))).toBe('3')
    expect(formatNumber(d('2.50'))).toBe('2.50')
    expect(formatNumber(d('-0.25'))).toBe('-0.25')
  })
})
