import Link from 'next/link'
import { portfolioUrl } from '@/lib/landing/portfolio'

const REPOSITORY_URL = 'https://github.com/LucaFastDev/doc-extract'

const linkClass = 'underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

// The landing page's footer (PRD F15 AC-5 and AC-6): the repository, the operator's portfolio when
// NEXT_PUBLIC_PORTFOLIO_URL is set, and the privacy and terms pages.
export function SiteFooter() {
  const portfolio = portfolioUrl(process.env.NEXT_PUBLIC_PORTFOLIO_URL)
  return (
    <footer className="border-t">
      <nav aria-label="Footer" className="mx-auto flex max-w-3xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted-foreground">
        <a href={REPOSITORY_URL} rel="noopener noreferrer" className={linkClass}>
          Source code
        </a>
        {portfolio && (
          <a href={portfolio} rel="noopener noreferrer" className={linkClass}>
            Portfolio
          </a>
        )}
        <Link href="/privacy" className={linkClass}>
          Privacy
        </Link>
        <Link href="/terms" className={linkClass}>
          Terms
        </Link>
      </nav>
    </footer>
  )
}
