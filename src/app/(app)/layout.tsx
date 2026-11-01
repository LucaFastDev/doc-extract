import type { ReactNode } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { getWorkspaceContext } from '@/lib/workspace/server'
import { signOut } from './actions'
import { DeleteAccount } from './delete-account'
import { NoWorkspace, WorkspaceSwitcher } from './workspace-switcher'

// Signed-in pages: the header with the workspace switcher, sign-out and account deletion. On a
// phone the two account buttons take a row of their own, so the switcher keeps its width. The proxy
// has already sent signed-out visitors to sign-in.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, memberships, current } = await getWorkspaceContext()

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <Link href="/documents" className="shrink-0 font-semibold tracking-tight">
            doc-extract
          </Link>
          <div className="min-w-0 flex-1">
            {current && <WorkspaceSwitcher workspaces={memberships} current={current} />}
          </div>
          <div className="flex w-full items-center justify-end gap-1 sm:w-auto">
            <DeleteAccount userId={user.id} />
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{current ? children : <NoWorkspace />}</div>
    </div>
  )
}
