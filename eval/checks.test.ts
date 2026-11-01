import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { utcDate } from '@shared/doctypes/checks'
import { amountTolerance, type DocumentValues } from '@shared/doctypes/fields'
import { DOC_TYPES } from '@shared/doctypes/index'
import { expectedFile } from './make-documents'
import { TOTALS, type ExpectedResult } from './score'
import { EVAL_DOCUMENTS, EXPECTED_DIR } from './values'

// Check usefulness (PRD section 10, issue #43 criterion 5): in the eval set, every seeded misread
// of a total or subtotal is flagged by an arithmetic check of shared/doctypes/.

const today = utcDate(new Date())

/** The checks' view of an expected result: fields and lines by name, empty ones as null. */
function documentValues(e: ExpectedResult): DocumentValues {
  const fields: Record<string, string | null> = {}
  const lines: Record<string, string | null>[] = []
  for (const f of e.fields) {
    const line = /^line_items\[(\d+)\]\.(.+)$/.exec(f.path)
    if (line) (lines[Number(line[1])] ??= {})[line[2]] = f.value
    else fields[f.path] = f.value
  }
  return { fields, line_items: lines }
}

/** A misread: the first digit read as the next one, as a 3 for an 8 would be (9 becomes 0). */
const misread = (value: string) => value.replace(/\d/, (d) => String((Number(d) + 1) % 10))

const expected = EVAL_DOCUMENTS.map((d) => JSON.parse(readFileSync(new URL(expectedFile(d), EXPECTED_DIR), 'utf8')) as ExpectedResult)

describe('check usefulness', () => {
  it('seeds a misread of every printed total and subtotal in the eval set', () => {
    const seeded = expected.flatMap((e) => TOTALS[e.doc_type].filter((name) => e.fields.find((f) => f.path === name)?.value))
    expect(seeded.length).toBeGreaterThanOrEqual(30)
    expect(misread('560.01')).toBe('660.01')
    expect(misread('9.50')).toBe('0.50')
  })

  for (const e of expected) {
    for (const name of TOTALS[e.doc_type]) {
      const value = e.fields.find((f) => f.path === name)?.value
      if (!value) continue
      it(`flags a misread ${name} on ${e.document} with an arithmetic check`, () => {
        const values = documentValues(e)
        values.fields[name] = misread(value)
        const checks = DOC_TYPES[e.doc_type].checks(values, { tolerance: amountTolerance(values.fields.currency ?? null, '0.01'), today })
        const flagged = checks.filter((c) => c.check_id.startsWith('A') && c.status === 'fail' && c.field_paths.includes(name))
        expect(flagged.map((c) => c.check_id), `${name} ${value} read as ${misread(value)}`).not.toEqual([])
      })
    }
  }
})
