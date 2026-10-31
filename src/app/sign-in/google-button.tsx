'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

// Google is the only sign-in method (PRD US-9.1 AC-1, OQ-21). Supabase Auth sends the user to
// Google and back to /auth/callback, which returns them to `next` (OQ-34).
export function GoogleSignInButton({ next, label = 'Continue with Google' }: { next: string; label?: string }) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  async function signIn() {
    setPending(true)
    setFailed(false)
    const callback = new URL('/auth/callback', window.location.origin)
    callback.searchParams.set('next', next)
    const { error } = await createClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callback.toString() },
    })
    if (error) {
      setPending(false)
      setFailed(true)
    }
  }

  return (
    <div className="grid gap-3">
      <Button type="button" size="lg" className="w-full" onClick={signIn} disabled={pending}>
        {label}
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Google sign-in could not start. Try again.
        </p>
      )}
    </div>
  )
}
