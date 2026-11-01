import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { AccuracySection } from '@/components/landing/accuracy-section'
import { accuracyTables, readEvalResults } from './eval-results'

// The landing page's accuracy tables (issue #45 criterion 4, ruling 2): built from fixture
// results files in the shape eval/README.md gives, never from eval/results/.

const TARGETS = {
  invoice: [0.95, 0.9],
  receipt: [0.92, 0.85],
  bank_statement: [0.95, 0.95],
  purchase_order: [0.95, 0.9],
  delivery_note: [0.95, 0.9],
  quote: [0.95, 0.9],
} as const

function resultsFile(model: string, date: string, header: number, lineItems: number | null) {
  const types: Record<string, unknown> = {}
  for (const [type, [headerTarget, lineTarget]] of Object.entries(TARGETS)) {
    types[type] = {
      documents: 5,
      header: { correct: 1, total: 1, accuracy: header, target: headerTarget, meets_target: header >= headerTarget },
      line_items: { correct: 1, total: 1, accuracy: lineItems, target: lineTarget, meets_target: lineItems === null ? null : lineItems >= lineTarget },
      type_detection: { correct: 5, total: 5 },
    }
  }
  return { date, model, prompt_version: 'test', types }
}

describe('accuracyTables', () => {
  const files = [
    resultsFile('claude-haiku-5-5', '2026-11-03', 0.9, 0.8),
    resultsFile('claude-sonnet-5-5', '2026-11-01', 0.1, 0.1),
    resultsFile('claude-sonnet-5-5', '2026-11-04', 0.9619, 0.974),
    resultsFile('claude-aardvark-1', '2026-11-02', 0.5, 0.5),
  ]

  it('uses each model’s newest file and puts claude-sonnet-5-5 first, then the others by name', () => {
    const tables = accuracyTables(files)
    expect(tables.map((t) => [t.model, t.date])).toEqual([
      ['claude-sonnet-5-5', '2026-11-04'],
      ['claude-aardvark-1', '2026-11-02'],
      ['claude-haiku-5-5', '2026-11-03'],
    ])
  })

  it('gives the six types in order, with whole-number percentages and the targets', () => {
    const [sonnet] = accuracyTables(files)
    expect(sonnet.rows).toEqual([
      { type: 'invoice', label: 'Invoice', header: '96%', lineItems: '97%', target: '95% / 90%' },
      { type: 'receipt', label: 'Receipt', header: '96%', lineItems: '97%', target: '92% / 85%' },
      { type: 'bank_statement', label: 'Bank statement', header: '96%', lineItems: '97%', target: '95% / 95%' },
      { type: 'purchase_order', label: 'Purchase order', header: '96%', lineItems: '97%', target: '95% / 90%' },
      { type: 'delivery_note', label: 'Delivery note', header: '96%', lineItems: '97%', target: '95% / 90%' },
      { type: 'quote', label: 'Quote', header: '96%', lineItems: '97%', target: '95% / 90%' },
    ])
  })

  it('shows a dash for a kind with no values', () => {
    const [table] = accuracyTables([resultsFile('claude-sonnet-5-5', '2026-11-04', 0.5, null)])
    expect(table.rows[0]).toMatchObject({ header: '50%', lineItems: '–' })
  })

  it('gives no table for no files, and fails on a value that is not a results file', () => {
    expect(accuracyTables([])).toEqual([])
    expect(() => accuracyTables([{ date: '2026-11-04' }])).toThrow('shape')
    expect(() => accuracyTables(['nonsense'])).toThrow('shape')
  })
})

describe('readEvalResults', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the .json files of the folder and nothing else', () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-results-'))
    writeFileSync(join(dir, '2026-11-04-claude-sonnet-5-5.json'), JSON.stringify(resultsFile('claude-sonnet-5-5', '2026-11-04', 0.9, 0.9)))
    writeFileSync(join(dir, '.gitkeep'), '')
    const tables = accuracyTables(readEvalResults(dir))
    expect(tables.map((t) => t.model)).toEqual(['claude-sonnet-5-5'])
  })

  it('fails, naming the file, when a .json file is not JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-results-'))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    expect(() => readEvalResults(dir)).toThrow('broken.json')
  })

  it('gives no files for an empty or missing folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-results-'))
    mkdirSync(join(dir, 'empty'))
    expect(readEvalResults(join(dir, 'empty'))).toEqual([])
    expect(readEvalResults(join(dir, 'missing'))).toEqual([])
  })
})

describe('AccuracySection', () => {
  const intro = 'Measured on a fixed set of 30 fictitious documents, 5 per type.'

  it('says the first run has not been published when there are no results', () => {
    const html = renderToStaticMarkup(createElement(AccuracySection, { tables: accuracyTables([]) }))
    expect(html).toContain('Measured accuracy')
    expect(html).toContain(intro)
    expect(html).toContain('The first accuracy run has not been published yet.')
    expect(html).not.toContain('<table')
  })

  it('shows one table per model, each with its run line', () => {
    const tables = accuracyTables([resultsFile('claude-haiku-5-5', '2026-11-03', 0.9, 0.8), resultsFile('claude-sonnet-5-5', '2026-11-04', 0.9, 0.8)])
    const html = renderToStaticMarkup(createElement(AccuracySection, { tables }))
    expect(html.match(/<table/g)).toHaveLength(2)
    expect(html).toContain('Run on 2026-11-04 with claude-sonnet-5-5.')
    expect(html).toContain('Run on 2026-11-03 with claude-haiku-5-5.')
    expect(html.indexOf('claude-sonnet-5-5')).toBeLessThan(html.indexOf('claude-haiku-5-5'))
    expect(html).not.toContain('has not been published')
  })
})
