import { describe, expect, it } from 'vitest'
import { latestDate, parseDate, utcDate } from './checks'
import { AMBIGUOUS_CURRENCY_SYMBOLS, currencyGuessed } from './currency'
import { normalisePart, normaliseText } from './duplicate'
import { lastFour, redactLastFour } from './fields'

// The rules every type shares: date sanity (PRD 4.2, OQ-6), the currency rule (US-7.1 AC-5,
// OQ-16), key normalisation for duplicates (PRD 4.3, Lead ruling 1 on #27) and the last four
// characters of sensitive numbers (OQ-29).

describe('dates', () => {
  it('reads only real YYYY-MM-DD dates', () => {
    expect(parseDate(' 2026-02-28 ')).toBe('2026-02-28')
    expect(parseDate('2024-02-29')).toBe('2024-02-29')
    for (const bad of ['2026-02-29', '2026-13-01', '26-10-01', '01.10.2026', '2026-10-1', '']) expect(parseDate(bad), bad).toBeNull()
  })

  it('allows one day after today, in UTC, for time zones', () => {
    expect(latestDate('2026-10-31')).toBe('2026-11-01')
    expect(latestDate('2026-12-31')).toBe('2027-01-01')
    expect(utcDate(new Date('2026-10-31T23:30:00-05:00'))).toBe('2026-11-01')
  })
})

describe('the currency rule', () => {
  it('lists the ambiguous symbols in one constant, with $, kr and ¥ among them', () => {
    for (const s of ['$', 'kr', '¥']) expect(AMBIGUOUS_CURRENCY_SYMBOLS).toContain(s)
    expect(AMBIGUOUS_CURRENCY_SYMBOLS).not.toContain('£')
  })

  it('counts no currency, or only an ambiguous symbol, as guessed', () => {
    for (const printed of [null, undefined, '', '  ', '$', ' $ ', 'kr', 'KR', 'kr.', '¥', '￥', 'Fr.', 'Rs']) {
      expect(currencyGuessed(printed), String(printed)).toBe(true)
    }
    for (const printed of ['€', 'EUR', 'US$', 'USD', 'CHF', 'SEK', '£', 'Euro']) expect(currencyGuessed(printed), printed).toBe(false)
  })
})

describe('duplicate key normalisation', () => {
  it('lower-cases text and removes all whitespace and punctuation', () => {
    expect(normaliseText('  Acme, Inc. ')).toBe('acmeinc')
    expect(normaliseText('INV – 1042/A')).toBe('inv1042a')
    expect(normaliseText('Müller & Söhne')).toBe('müllersöhne')
  })

  it('reads dates as dates and amounts as exact decimals', () => {
    expect(normalisePart('2026-10-01', 'date')).toBe('20261001')
    expect(normalisePart('12.50', 'amount')).toBe('12.5')
    expect(normalisePart('12.5', 'amount')).toBe('12.5')
    expect(normalisePart('012.00', 'amount')).toBe('12')
    expect(normalisePart('1250', 'amount')).toBe('1250')
    expect(normalisePart('0.50', 'amount')).toBe('0.5')
    expect(normalisePart('-3.10', 'amount')).toBe('-3.1')
  })
})

describe('the last four characters (OQ-29)', () => {
  it('keeps the last four characters without spaces', () => {
    expect(lastFour('4000 1234 5678 9010')).toBe('9010')
    expect(lastFour('**** 42')).toBe('**42')
    expect(lastFour('7781')).toBe('7781')
  })

  it('cuts those fields wherever they are in a tool input or a response, and nothing else', () => {
    const response = {
      content: [{ type: 'tool_use', input: { card_last4: { value: '4000 1234 5678 9010', confidence: 0.9 }, total: { value: '10.00', confidence: 1 } } }],
      iban_last4: 'not a field',
    }
    expect(redactLastFour(response)).toEqual({
      content: [{ type: 'tool_use', input: { card_last4: { value: '9010', confidence: 0.9 }, total: { value: '10.00', confidence: 1 } } }],
      iban_last4: 'not a field',
    })
    expect(redactLastFour(null)).toBeNull()
  })
})
