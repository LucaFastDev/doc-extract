// The review screen's changes, one at a time (PRD US-5.1 AC-4 to AC-6). A field is saved when it
// loses focus, and the click that took the focus away lands while that save is still running, so
// the clicked action waits for the save and then runs on the saved values: one click both saves
// the correction and approves, adds a line or ticks a check.

/** One change: resolves true when it was stored, false when it was refused. */
export type Change = () => Promise<boolean>

/**
 * Returns a function that runs each change after every change asked for before it has finished.
 * When a change is refused or throws, the changes already waiting behind it are dropped, since
 * each was asked for on top of it; a change asked for once the queue is empty runs as usual.
 * `onIdle` is called each time the last waiting change has finished. The returned promise
 * resolves true only when the change ran and was stored.
 */
export function changeQueue(onIdle: () => void): (change: Change) => Promise<boolean> {
  let tail: Promise<unknown> = Promise.resolve()
  let waiting = 0
  let failed = false

  return (change) => {
    waiting++
    const run = tail.then(async () => {
      try {
        if (failed) return false
        const stored = await change()
        if (!stored) failed = true
        return stored
      } catch (e) {
        failed = true
        throw e
      } finally {
        if (--waiting === 0) {
          failed = false
          onIdle()
        }
      }
    })
    tail = run.catch(() => undefined)
    return run
  }
}
