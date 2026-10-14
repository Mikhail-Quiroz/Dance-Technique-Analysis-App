import type { NextConfig } from "next";
import os from "node:os";

// The backend the browser calls (frontend/.env.local; Next loads it before this file).
const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000").replace(/\/$/, "");
const BACKEND_IS_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BACKEND).hostname);

/** This computer's addresses on the local network, where a phone on the same Wi-Fi finds it. */
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

const nextConfig: NextConfig = {
  // The dev server only trusts the hostname it booted with (localhost).
  // Without this, opening the app at http://127.0.0.1:3000 serves HTML but
  // 403s the dev assets — the page renders and never hydrates. The same goes for
  // a phone opening it by this computer's network address (npm run dev:phone).
  allowedDevOrigins: ["127.0.0.1", ...lanAddresses()],
  // Hide the floating dev-tools button; errors still appear as overlays.
  devIndicators: false,
  experimental: {
    // Next buffers a request body for the middleware (proxy) up to this size - even on /backend/,
    // which the middleware's matcher skips - and cut iPhone uploads (50-150 MB) at the default
    // 10 MB, so saving one failed with "socket hang up". The backend caps a video at 200 MB.
    proxyClientMaxBodySize: "250mb",
  },
  async rewrites() {
    // A backend on this computer, reached through this server: a phone on the Wi-Fi cannot call
    // "localhost" (that is the phone), and an https page may not call plain http. lib/sessions.ts
    // switches to /backend when the page is opened that way.
    if (!BACKEND_IS_LOCAL) return [];
    // uvicorn listens on 127.0.0.1; "localhost" may resolve to ::1 first.
    return [{ source: "/backend/:path*", destination: `${BACKEND.replace("//localhost", "//127.0.0.1")}/:path*` }];
  },
};

export default nextConfig;
