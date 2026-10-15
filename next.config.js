/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The custom Node server owns HTTP + WebSocket upgrade handling, so we do not
  // rely on `output: 'standalone'` tracing to ship server-side native modules.
  compress: true,
  typescript: { ignoreBuildErrors: false },
  typedRoutes: true
};

module.exports = nextConfig;
