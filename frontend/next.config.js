/** @type {import('next').NextConfig} */
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig = {
  // Keep `next dev` from writing an AGENTS.md into the project when it detects a coding agent.
  agentRules: false,
  experimental: {
    // The /api proxy drops requests after 30s by default. Training with CV tuning
    // over a long history can take minutes, so allow up to 10.
    proxyTimeout: 10 * 60 * 1000,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
  async redirects() {
    // Bid preparation moved into the Workstation at "/".
    return [{ source: "/bids", destination: "/", permanent: true }];
  },
};

module.exports = nextConfig;
