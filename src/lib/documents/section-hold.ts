// When the review screen lets go of the sections it holds while the user is in the fields (Lead
// ruling 2 on PR #35): only once the focus has really left the fields. A blur's save can finish
// before the focus reaches the next field, and a press on a label or a field's border takes the
// focus away and gives it to the field only on release, so the focus is judged a task later, and
// not while a press is under way: moving from one field to another, by click or Tab, keeps them.

export type SectionHold = {
  /** A change was asked for. */
  busy(): void
  /** Every change has finished. */
  idle(): void
  /** A mouse button or touch went down. */
  press(): void
  /** It was released or cancelled. */
  lift(): void
}

/**
 * Calls `release` once every change has finished, no press is under way and, a task after the
 * last of those, `inField` says the focus is not in a field. `later` runs a function a task later.
 */
export function sectionHold(
  inField: () => boolean,
  release: () => void,
  later: (run: () => void) => void = (run) => void setTimeout(run),
): SectionHold {
  let idle = true
  let pressed = false
  const settle = () =>
    later(() => {
      if (idle && !pressed && !inField()) release()
    })
  return {
    busy() {
      idle = false
    },
    idle() {
      idle = true
      settle()
    },
    press() {
      pressed = true
    },
    lift() {
      pressed = false
      settle()
    },
  }
}
