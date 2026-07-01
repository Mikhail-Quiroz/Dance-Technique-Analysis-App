import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev server only trusts the hostname it booted with (localhost).
  // Without this, opening the app at http://127.0.0.1:3000 serves HTML but
  // 403s the dev assets — the page renders and never hydrates.
  allowedDevOrigins: ["127.0.0.1"],
  // Hide the floating dev-tools button; errors still appear as overlays.
  devIndicators: false,
};

export default nextConfig;
