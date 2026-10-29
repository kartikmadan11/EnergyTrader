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
    // Fallback rewrites run after the app's own routes, so /api/auth/* reaches Auth.js
    // and every other /api request goes to the backend.
    return {
      fallback: [
        {
          source: "/api/:path*",
          destination: `${BACKEND_URL}/api/:path*`,
        },
      ],
    };
  },
  async redirects() {
    // Bid preparation lives in the Workstation.
    return [{ source: "/bids", destination: "/workstation", permanent: true }];
  },
};

export default nextConfig;
