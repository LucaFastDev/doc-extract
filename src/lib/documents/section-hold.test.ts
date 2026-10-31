import { describe, expect, it, vi } from 'vitest'
import { sectionHold } from './section-hold'

// The review screen's sections stay as they are while the user is in the fields, and re-sort only
// once the focus has really left them (Lead ruling 2 on PR #35, ruling 1 on its QA pass 3).

/** A hold whose "a task later" runs only when `flush` is called, with the focus set by the test. */
function setup() {
  let focused = false
  const pending: (() => void)[] = []
  const release = vi.fn()
  const hold = sectionHold(
    () => focused,
    release,
    (run) => pending.push(run),
  )
  const focus = (inField: boolean) => {
    focused = inField
  }
  const flush = () => pending.splice(0).forEach((run) => run())
  return { hold, release, focus, flush }
}

describe('sectionHold', () => {
  it('keeps the sections when a save ends while the focus is between two fields', () => {
    const { hold, release, focus, flush } = setup()
    focus(true)
    hold.busy()
    // The blur of one field: its save ends before the next field has the focus.
    focus(false)
    hold.idle()
    expect(release).not.toHaveBeenCalled()
    // The focus reaches the next field in the same task, before the hold looks.
    focus(true)
    flush()
    expect(release).not.toHaveBeenCalled()
  })

  it('lets go once the focus has settled outside the fields and every change has finished', () => {
    const { hold, release, focus, flush } = setup()
    hold.busy()
    focus(false)
    hold.idle()
    flush()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps the sections while a change is still running', () => {
    const { hold, release, focus, flush } = setup()
    hold.busy()
    hold.busy()
    focus(false)
    hold.idle()
    hold.busy()
    flush()
    expect(release).not.toHaveBeenCalled()
  })

  it('judges a press on a label only once it is released', () => {
    const { hold, release, focus, flush } = setup()
    // Pressing a label blurs the field; its save ends while the button is still down.
    hold.press()
    hold.busy()
    focus(false)
    hold.idle()
    flush()
    expect(release).not.toHaveBeenCalled()
    // The release gives the focus to the label's field.
    focus(true)
    hold.lift()
    flush()
    expect(release).not.toHaveBeenCalled()
  })

  it('lets go when a press outside the fields is released', () => {
    const { hold, release, focus, flush } = setup()
    hold.press()
    hold.busy()
    focus(false)
    hold.idle()
    flush()
    hold.lift()
    flush()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
