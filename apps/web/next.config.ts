import type { NextConfig } from 'next';

/**
 * Same-origin `/api/v1` for cookie + CSRF (CP018). The browser never talks to
 * the API origin directly; Next rewrites so `devguard_session` stays first-party.
 * Override the upstream with DEVGUARD_API_ORIGIN (local.mjs uses :4000).
 */
const apiOrigin = (process.env['DEVGUARD_API_ORIGIN'] ?? 'http://127.0.0.1:4000').replace(
  /\/+$/,
  '',
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@devguard/api-contracts', '@devguard/contracts', '@devguard/errors'],
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${apiOrigin}/api/v1/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
