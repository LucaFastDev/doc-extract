import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import ErrorPage from './error'
import GlobalError from './global-error'

// Issue #132, criterion 3: the error pages say "Something went wrong.", offer Try again, which
// calls reset, and a link back to the documents list, and never show the error's message or stack.

const thrown = Object.assign(new Error('relation "secret_table" does not exist'), { digest: 'abc123' })

/** The first element in the tree whose type is the given component. */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement<{ children?: ReactNode }>(node)) return null
  if (node.type === type) return node as ReactElement<Record<string, unknown>>
  for (const child of Children.toArray(node.props.children)) {
    const found = find(child, type)
    if (found) return found
  }
  return null
}

for (const [name, page] of [
  ['error.tsx', ErrorPage],
  ['global-error.tsx', GlobalError],
] as const) {
  describe(name, () => {
    it('shows the heading, the Try again button and the link to the documents list, without the error', () => {
      const html = renderToStaticMarkup(createElement(page, { error: thrown, reset: () => {} }))
      expect(html).toMatch(/<h1[^>]*>Something went wrong\.<\/h1>/)
      expect(html).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/)
      expect(html).toMatch(/<a[^>]*href="\/documents"[^>]*>Go to your documents<\/a>/)
      expect(html).not.toContain('secret_table')
      expect(html).not.toContain('abc123')
      expect(html).not.toContain(' at ')
    })

    it('renders the shared error state with the reset function it was given', () => {
      const reset = vi.fn()
      const tree = page({ error: thrown, reset })
      const state = find(tree, ErrorState)
      expect(state?.props.reset).toBe(reset)
    })
  })
}

describe('global-error.tsx', () => {
  it('brings its own html and body, as it replaces the root layout', () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: thrown, reset: () => {} }))
    expect(html).toMatch(/^<html lang="en">.*<body class="min-h-dvh antialiased">.*<\/body><\/html>$/)
    expect(html).toContain('<title>doc-extract</title>')
  })
})

describe('ErrorState', () => {
  it('calls reset when Try again is pressed', () => {
    const reset = vi.fn()
    const button = find(ErrorState({ reset }), Button)
    expect(Children.toArray(button?.props.children as ReactNode)).toEqual(['Try again'])
    expect(reset).not.toHaveBeenCalled()
    ;(button?.props.onClick as () => void)()
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
