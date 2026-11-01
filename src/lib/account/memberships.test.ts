import { describe, expect, it } from 'vitest'
import { refusalMessage, soleMemberNote, sortAccountWorkspaces, type MemberRow } from './memberships'

const ME = 'me'
const row = (workspaceId: string, name: string, userId: string, role: MemberRow['role']): MemberRow => ({ workspaceId, name, userId, role })

// Which workspaces stop an account being deleted and which go with it (issue #61, ruling 5).
describe('sortAccountWorkspaces', () => {
  it('counts a workspace with one member as going with the account, whatever that member’s role', () => {
    const { soleMember, onlyOwner } = sortAccountWorkspaces([row('a', 'Alone', ME, 'owner'), row('b', 'Left over', ME, 'member')], ME)
    expect(soleMember).toEqual([
      { id: 'a', name: 'Alone' },
      { id: 'b', name: 'Left over' },
    ])
    expect(onlyOwner).toEqual([])
  })

  it('refuses for a workspace where the caller is the only owner and others are members', () => {
    const { soleMember, onlyOwner } = sortAccountWorkspaces([row('a', 'Team', ME, 'owner'), row('a', 'Team', 'other', 'member')], ME)
    expect(onlyOwner).toEqual([{ id: 'a', name: 'Team' }])
    expect(soleMember).toEqual([])
  })

  it('never refuses for a workspace with a second owner', () => {
    const { soleMember, onlyOwner } = sortAccountWorkspaces(
      [row('a', 'Team', ME, 'owner'), row('a', 'Team', 'other', 'owner'), row('a', 'Team', 'third', 'member')],
      ME,
    )
    expect(onlyOwner).toEqual([])
    expect(soleMember).toEqual([])
  })

  it('neither refuses for nor deletes a workspace where the caller is a plain member', () => {
    const { soleMember, onlyOwner } = sortAccountWorkspaces([row('a', 'Team', ME, 'member'), row('a', 'Team', 'other', 'owner')], ME)
    expect(onlyOwner).toEqual([])
    expect(soleMember).toEqual([])
  })

  it('sorts each list by name', () => {
    const { onlyOwner } = sortAccountWorkspaces(
      [row('z', 'Zebra', ME, 'owner'), row('z', 'Zebra', 'x', 'member'), row('b', 'Apple', ME, 'owner'), row('b', 'Apple', 'x', 'member')],
      ME,
    )
    expect(onlyOwner.map((w) => w.name)).toEqual(['Apple', 'Zebra'])
  })
})

describe('the account dialog’s sentences (ruling 8)', () => {
  it('the refusal names the workspaces', () => {
    expect(refusalMessage(['Acme', 'Beta'])).toBe(
      'You are the only owner of Acme, Beta, which still have other members. Make another member an owner of each, or delete it first.',
    )
  })

  it('the note names the workspaces that go with the account', () => {
    expect(soleMemberNote(['Personal', 'Old'])).toBe('These workspaces have no other members and are deleted with all their data: Personal, Old.')
  })
})
