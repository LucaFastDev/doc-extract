import type { Metadata } from 'next'
import { LegalPage } from '@/components/legal-page'

export const metadata: Metadata = { title: 'Privacy · doc-extract' }

// PRD US-18.3 AC-1; the copy is the Lead's, from issue #45.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" other={{ href: '/terms', label: 'Terms' }}>
      <p>doc-extract is a demonstration project. This page says what it stores and who processes it.</p>
      <p>Sign-in is through Google. The app stores your name and email address from your Google account.</p>
      <p>
        Documents you upload are stored in Supabase and sent to Anthropic, which reads them with Claude to extract the data. They
        are not used for anything else.
      </p>
      <p>
        Uploaded files are deleted 7 days after upload. The extracted fields, check results and approvals stay until you delete
        the document, the workspace or your account, and deleting any of these removes its data at once.
      </p>
      <p>Billing runs in Stripe test mode. No real card is charged, and Stripe holds any card details, not this app.</p>
      <p>The demo needs no account. Your edits and exports there stay in your browser and are never saved.</p>
      <p>The site is hosted on Vercel.</p>
    </LegalPage>
  )
}
