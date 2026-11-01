import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // next dev would otherwise write an AGENTS.md when an agent runs it; CLAUDE.md is this repo's
  // agent guide and points at the same bundled docs.
  agentRules: false,
  // The landing page reads the eval results from disk while it is built and when Vercel rebuilds
  // it (revalidate); only traced files exist there, and nothing imports these.
  outputFileTracingIncludes: { '/': ['./eval/results/*.json'] },
}

export default nextConfig
