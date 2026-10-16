/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `npm run dev` binds 127.0.0.1 and prints that URL, so the page's origin really is
  // 127.0.0.1: Next blocks its own dev resources (the /_next/hmr socket) for any origin it
  // has not been told to trust, and a page whose hot-reload socket never opens never
  // hydrates. Production ignores this key.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  poweredByHeader: false,
  // The custom Node server owns HTTP + WebSocket upgrade handling, so we do not
  // rely on `output: 'standalone'` tracing to ship server-side native modules.
  compress: true,
  typescript: { ignoreBuildErrors: false },
  typedRoutes: true
};

module.exports = nextConfig;
