import type { NextConfig } from "next";

// Static export: served by the FastAPI backend, installed as a PWA, and bundled into the Android app.
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Every route gets its own index.html, so reloads and deep links work from plain file servers (Capacitor)
  trailingSlash: true,
  reactStrictMode: true,
};

export default config;
