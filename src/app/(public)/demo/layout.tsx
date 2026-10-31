import type { ReactNode } from 'react'
import Link from 'next/link'

// The public demo's pages (PRD F13): open to everyone, signed in or not, with no workspace.
export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link href="/" className="shrink-0 font-semibold tracking-tight">
            doc-extract
          </Link>
          <Link href="/demo" className="text-sm text-muted-foreground hover:text-foreground">
            Demo
          </Link>
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</div>
    </div>
  )
}
