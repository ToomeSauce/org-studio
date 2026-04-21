import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack is the default bundler in Next.js 16 — no extra config needed.

  // Compress output for smaller transfers
  compress: true,

  // Strict React mode for catching issues early
  reactStrictMode: true,

  // Silence the multi-lockfile workspace root warning
  turbopack: {
    root: '.',
  },
};

export default nextConfig;
