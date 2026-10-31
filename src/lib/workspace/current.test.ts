import { describe, expect, it } from 'vitest'
import { pickCurrentWorkspace, type Membership } from './current'

const personal: Membership = { id: 'w-personal', name: 'Personal', role: 'owner', joinedAt: '2026-10-01T00:00:00Z' }
const team: Membership = { id: 'w-team', name: 'Team', role: 'member', joinedAt: '2026-10-05T00:00:00Z' }

describe('pickCurrentWorkspace', () => {
  it('uses the workspace in the cookie when the user is a member of it', () => {
    expect(pickCurrentWorkspace([personal, team], 'w-team')).toBe(team)
  })

  it('falls back to the personal workspace, the first joined, for an unknown id', () => {
    expect(pickCurrentWorkspace([team, personal], 'w-someone-elses')).toBe(personal)
  })

  it('falls back to the personal workspace without a cookie', () => {
    expect(pickCurrentWorkspace([team, personal], undefined)).toBe(personal)
  })

  it('returns null for a user with no workspace', () => {
    expect(pickCurrentWorkspace([], 'w-team')).toBeNull()
  })
})
