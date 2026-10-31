import { describe, expect, it, vi } from 'vitest'
import { changeQueue } from './change-queue'

// The review screen's changes run one at a time (PRD US-5.1 AC-4 to AC-6): a click that lands
// while a field is still being saved runs its action after the save, on the saved values.

/** A change that waits until it is let go, and records when it starts and ends. */
function gate(log: string[], name: string, stored = true) {
  let release!: () => void
  const released = new Promise<void>((r) => (release = r))
  const change = async () => {
    log.push(`${name} start`)
    await released
    log.push(`${name} end`)
    return stored
  }
  return { change, release }
}

describe('changeQueue', () => {
  it('runs a change asked for while another runs only after that one has finished', async () => {
    const log: string[] = []
    const queue = changeQueue(() => log.push('idle'))
    const save = gate(log, 'save')
    const approve = gate(log, 'approve')

    const saved = queue(save.change)
    const approved = queue(approve.change)
    await Promise.resolve()
    expect(log).toEqual(['save start'])

    save.release()
    await saved
    approve.release()
    expect(await approved).toBe(true)
    expect(log).toEqual(['save start', 'save end', 'approve start', 'approve end', 'idle'])
  })

  it('drops the changes waiting behind a refused one, then runs the next change as usual', async () => {
    const onIdle = vi.fn()
    const queue = changeQueue(onIdle)
    const approve = vi.fn(async () => true)

    const saved = queue(async () => false)
    const approved = queue(approve)
    expect(await saved).toBe(false)
    expect(await approved).toBe(false)
    expect(approve).not.toHaveBeenCalled()
    expect(onIdle).toHaveBeenCalledTimes(1)

    expect(await queue(approve)).toBe(true)
    expect(approve).toHaveBeenCalledTimes(1)
    expect(onIdle).toHaveBeenCalledTimes(2)
  })

  it('treats a change that throws as refused, and passes the error on', async () => {
    const queue = changeQueue(() => {})
    const tick = vi.fn(async () => true)

    const failed = queue(async () => {
      throw new Error('network')
    })
    const ticked = queue(tick)
    await expect(failed).rejects.toThrow('network')
    expect(await ticked).toBe(false)
    expect(tick).not.toHaveBeenCalled()

    expect(await queue(tick)).toBe(true)
  })

  it('calls onIdle once the last waiting change has finished, not before', async () => {
    const log: string[] = []
    const queue = changeQueue(() => log.push('idle'))
    const first = gate(log, 'first')
    const second = gate(log, 'second')

    const a = queue(first.change)
    const b = queue(second.change)
    first.release()
    await a
    expect(log).not.toContain('idle')
    second.release()
    await b
    expect(log.at(-1)).toBe('idle')
    expect(log.filter((l) => l === 'idle')).toHaveLength(1)
  })
})
