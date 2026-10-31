import { describe, expect, it } from 'vitest'
import { csvField, guardFormula, toCsv } from './csv'

// The CSV writer (PRD US-6.1 AC-5, RFC 4180) and the formula guard on text values (Lead ruling 3
// on #39).

describe('csvField', () => {
  it('leaves a plain value as it is', () => {
    expect(csvField('Acme Supplies Ltd')).toBe('Acme Supplies Ltd')
    expect(csvField('1180.00')).toBe('1180.00')
  })

  it('quotes a value with a comma', () => {
    expect(csvField('Berlin, Germany')).toBe('"Berlin, Germany"')
  })

  it('quotes a value with a double quote and doubles the quote', () => {
    expect(csvField('The "best" widgets')).toBe('"The ""best"" widgets"')
    expect(csvField('"')).toBe('""""')
  })

  it('quotes a value with a carriage return or a line feed', () => {
    expect(csvField('line 1\rline 2')).toBe('"line 1\rline 2"')
    expect(csvField('line 1\nline 2')).toBe('"line 1\nline 2"')
    expect(csvField('line 1\r\nline 2')).toBe('"line 1\r\nline 2"')
  })

  it('quotes a value with leading or trailing spaces, so no reader trims them', () => {
    expect(csvField(' leading')).toBe('" leading"')
    expect(csvField('trailing ')).toBe('"trailing "')
    expect(csvField('  both  ')).toBe('"  both  "')
    expect(csvField('in the middle')).toBe('in the middle')
  })

  it('writes an empty value as an empty field', () => {
    expect(csvField('')).toBe('')
  })

  it('keeps non-ASCII text as it is', () => {
    expect(csvField('Müller & Söhne – Straße 5, 東京')).toBe('"Müller & Söhne – Straße 5, 東京"')
    expect(csvField('Café')).toBe('Café')
  })
})

describe('toCsv', () => {
  it('writes a header row and the rows, each ended by CRLF', () => {
    expect(
      toCsv([
        ['document_id', 'file_name', 'total'],
        ['d1', 'a, b.pdf', '12.50'],
        ['d2', '', ''],
      ]),
    ).toBe('document_id,file_name,total\r\nd1,"a, b.pdf",12.50\r\nd2,,\r\n')
  })
})

describe('guardFormula (Lead ruling 3)', () => {
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    it(`puts a single quote before a text value that starts with ${JSON.stringify(lead)}`, () => {
      expect(guardFormula(`${lead}1+1`)).toBe(`'${lead}1+1`)
    })
  }

  it('leaves any other text as it is', () => {
    expect(guardFormula('Acme')).toBe('Acme')
    expect(guardFormula('a=b')).toBe('a=b')
    expect(guardFormula(' =1')).toBe(' =1')
    expect(guardFormula("'quoted")).toBe("'quoted")
    expect(guardFormula('')).toBe('')
  })
})
