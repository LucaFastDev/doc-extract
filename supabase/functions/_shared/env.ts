// Every function reads its settings here (ARCHITECTURE.md section 6.1). A missing value throws at
// startup: nothing has a default that points at a real service.

export function requireEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not set`)
  return value
}
