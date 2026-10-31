'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { DEFAULT_PATH } from '@/lib/auth/paths'
import { signedInClient } from '@/lib/auth/server'
import { acceptRefusal, type AcceptRefusal } from '@/lib/workspace/members'
import { setCurrentWorkspace } from '@/lib/workspace/server'

export interface AcceptState {
  refusal?: AcceptRefusal
}

// Accepts an invitation as the signed-in user (PRD US-8.2 AC-2 and AC-3, OQ-18). accept_invite
// checks the address, expiry and single use; on success the workspace becomes the current one.
export async function acceptInvite(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const supabase = await signedInClient()
  const token = String(formData.get('token') ?? '')

  const { data: ws, error } = await supabase.rpc('accept_invite', { token })
  if (error || typeof ws !== 'string') return { refusal: acceptRefusal(error?.code) }

  await setCurrentWorkspace(ws)
  revalidatePath('/', 'layout')
  redirect(DEFAULT_PATH)
}
