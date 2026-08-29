import type { NextConfig } from 'next';

const nextConfig: NextConfig & { agentRules?: boolean } = {
  agentRules: false,
};

export default nextConfig;
