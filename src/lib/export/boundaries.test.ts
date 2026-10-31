import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Where the export's code may be imported from (issue #39 criterion 7 and Lead ruling 4): the
// file-building modules read no Supabase and import no React, so the demo can call them
// (milestone 11), and the zip and XLSX libraries are loaded only by files.ts, which the export page
// imports dynamically, on Download, so they reach no other page's bundle.

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SRC = join(ROOT, 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : []
  })
}

/** Every module a file imports statically (import … from, export … from), not import(). */
function staticImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm), ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  )
}

describe('the file-building modules', () => {
  for (const name of ['csv.ts', 'model.ts', 'files.ts']) {
    it(`${name} imports no Supabase or React module`, () => {
      const imports = staticImports(join(SRC, 'lib', 'export', name))
      expect(imports.filter((m) => /supabase|^react|^next|^@\/lib\/supabase/.test(m))).toEqual([])
      // Only the shared definitions, the export's own modules and the two libraries.
      for (const m of imports) expect(m).toMatch(/^(@shared\/|\.\/(csv|model)$|fflate$|write-excel-file\/universal$)/)
    })
  }
})

describe('the zip and XLSX libraries', () => {
  it('are imported statically only by src/lib/export/files.ts', () => {
    const importers = sources(SRC)
      .filter((f) => staticImports(f).some((m) => /^(fflate|write-excel-file)(\/|$)/.test(m)))
      .map((f) => relative(ROOT, f))
    expect(importers).toEqual([join('src', 'lib', 'export', 'files.ts')])
  })

  it('reach the page only through a dynamic import of files.ts', () => {
    const staticFiles = sources(SRC).filter((f) => staticImports(f).some((m) => /export\/files$/.test(m)))
    expect(staticFiles.map((f) => relative(ROOT, f))).toEqual([])
    const view = readFileSync(join(SRC, 'app', '(app)', 'documents', 'export', 'export-view.tsx'), 'utf8')
    expect(view).toMatch(/await import\('@\/lib\/export\/files'\)/)
  })
})
