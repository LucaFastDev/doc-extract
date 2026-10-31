import type { ReactNode } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { getWorkspaceContext } from '@/lib/workspace/server'
import { signOut } from './actions'
import { WorkspaceSwitcher } from './workspace-switcher'

// Signed-in pages: the header with the workspace switcher and sign-out. The proxy has already
// sent signed-out visitors to sign-in.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { memberships, current } = await getWorkspaceContext()

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link href="/documents" className="shrink-0 font-semibold tracking-tight">
            doc-extract
          </Link>
          <div className="min-w-0 flex-1">
            {current && <WorkspaceSwitcher workspaces={memberships} current={current} />}
          </div>
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</div>
    </div>
  )
}
