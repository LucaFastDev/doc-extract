import { describe, expect, it } from 'vitest'
import {
  acceptRefusal,
  createInviteError,
  isLastOwner,
  isRole,
  LAST_OWNER_MESSAGE,
  memberChangeError,
} from './members'

describe('isRole', () => {
  it('accepts owner and member only', () => {
    expect(['owner', 'member', 'admin', '', null, undefined].map(isRole)).toEqual([true, true, false, false, false, false])
  })
})

describe('isLastOwner', () => {
  it('is true only for the one owner of a workspace', () => {
    const members = [
      { userId: 'a', role: 'owner' as const },
      { userId: 'b', role: 'member' as const },
    ]
    expect(isLastOwner(members, 'a')).toBe(true)
    expect(isLastOwner(members, 'b')).toBe(false)
  })

  it('is false for every owner while there are two', () => {
    const members = [
      { userId: 'a', role: 'owner' as const },
      { userId: 'b', role: 'owner' as const },
    ]
    expect(isLastOwner(members, 'a')).toBe(false)
    expect(isLastOwner(members, 'b')).toBe(false)
  })
})

describe('database refusals', () => {
  it('explain the last-owner refusal', () => {
    expect(memberChangeError('23514')).toBe(LAST_OWNER_MESSAGE)
  })

  it('tell a member that only an owner may change members or invite', () => {
    expect(memberChangeError('42501')).toMatch(/Only an owner/)
    expect(createInviteError('42501')).toMatch(/Only an owner/)
  })

  it('ask for a valid address when the database refuses one', () => {
    expect(createInviteError('22023')).toBe('Enter a valid email address.')
  })

  it('fall back to try again for anything else', () => {
    expect(memberChangeError(undefined)).toMatch(/Try again/)
    expect(createInviteError('PGRST301')).toMatch(/Try again/)
  })

  it('sort an invitation refusal into not for you, no longer valid, already a member or failed', () => {
    expect(['42501', 'P0002', '23505', '08006', undefined].map(acceptRefusal)).toEqual([
      'not-for-you',
      'no-longer-valid',
      'already-member',
      'failed',
      'failed',
    ])
  })
})
