import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // next dev would otherwise write an AGENTS.md when an agent runs it; CLAUDE.md is this repo's
  // agent guide and points at the same bundled docs.
  agentRules: false,
}

export default nextConfig
