// The limit on a workspace's name, shared by the server actions and the forms (no server imports,
// since a 'use server' file can export only async functions).

export const NAME_TOO_LONG = 'Use 100 characters or fewer for the workspace name.'

// A name longer than this many UTF-16 units, before trimming, is refused in the browser: a server
// action's body is limited to 1 MB, and a request past it fails before the action runs.
export const MAX_NAME_UNITS = 10_000

// Counts code points, as char_length does in the database's check on workspaces.name.
export function nameTooLong(name: string) {
  return Array.from(name).length > 100
}

// What the browser refuses before any request: more than 100 code points once trimmed, as the
// action counts them, or more than MAX_NAME_UNITS units as typed, which covers a huge paste of
// mostly spaces that trims down to something short.
export function nameTooLongForBrowser(typed: string) {
  return typed.length > MAX_NAME_UNITS || nameTooLong(typed.trim())
}
