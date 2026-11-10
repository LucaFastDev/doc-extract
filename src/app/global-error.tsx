'use client'

import { ErrorState } from '@/components/error-state'
import './globals.css'

// An error in the root layout itself (issue #132, criterion 3). It replaces the root layout, so it
// brings its own <html>, <body> and styles, as src/app/layout.tsx sets them. No metadata export is
// allowed here, so the title is React's <title>.
export default function GlobalError({ reset }: { error: unknown; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <title>doc-extract</title>
        <ErrorState reset={reset} />
      </body>
    </html>
  )
}
