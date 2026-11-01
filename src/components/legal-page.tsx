import type { ReactNode } from 'react'
import Link from 'next/link'

const linkClass = 'underline underline-offset-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

// A short public page (PRD US-18.3): a title, its paragraphs, and links back to the landing page
// and to the other legal page.
export function LegalPage({ title, other, children }: { title: string; other: { href: string; label: string }; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 py-12 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <div className="flex flex-col gap-4">{children}</div>
      <nav aria-label="More" className="flex flex-wrap gap-x-6 gap-y-2 border-t pt-6 text-sm">
        <Link href="/" className={linkClass}>
          doc-extract home
        </Link>
        <Link href={other.href} className={linkClass}>
          {other.label}
        </Link>
      </nav>
    </main>
  )
}
