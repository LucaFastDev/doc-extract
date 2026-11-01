import type { Metadata } from 'next'
import { LegalPage } from '@/components/legal-page'

export const metadata: Metadata = { title: 'Terms · doc-extract' }

// PRD US-18.3 AC-1; the copy is the Lead's, from issue #45.
export default function TermsPage() {
  return (
    <LegalPage title="Terms" other={{ href: '/privacy', label: 'Privacy' }}>
      <p>doc-extract is a demonstration project, offered as is, with no warranty and no guarantee of availability.</p>
      <p>Do not upload documents you are not allowed to share, or anything you could not afford to lose.</p>
      <p>Check extracted values before you rely on them. The app flags what it can, but it can be wrong.</p>
      <p>Billing is in Stripe test mode: no real payment is taken and paying gives no rights to service.</p>
      <p>Accounts, workspaces and data may be removed at any time. You can delete your workspace or account yourself.</p>
      <p>The source code is MIT licensed; see the repository.</p>
    </LegalPage>
  )
}
