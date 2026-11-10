'use client'

import { ErrorState } from '@/components/error-state'

// An error thrown while rendering a page, below the root layout (issue #132, criterion 3). Error
// boundaries are Client Components. The error prop is not read: no message or stack is shown.
export default function ErrorPage({ reset }: { error: unknown; reset: () => void }) {
  return <ErrorState reset={reset} />
}
