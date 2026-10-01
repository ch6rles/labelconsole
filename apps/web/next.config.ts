import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// One .env at the repo root serves the web app, the worker and the scripts.
// forceReload: Next has already loaded (and cached) env for apps/web, which has no .env of its own.
loadEnvConfig(path.join(import.meta.dirname, '../..'), process.env.NODE_ENV !== 'production', { info: () => {}, error: console.error }, true);

const modules = ['people', 'drive', 'network', 'catalogue', 'documents', 'streams', 'marketing', 'agents', 'inbox', 'settings'];

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@labelconsole/core', '@labelconsole/ui', ...modules.map((m) => `@labelconsole/${m}`)],
  serverExternalPackages: ['pino', 'bullmq', 'ioredis', 'postgres', 'unpdf', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  turbopack: { root: path.join(import.meta.dirname, '../..') },
  async rewrites() {
    // The spec's public paths (/v1/metadata/resolve, /v1/streams/...) map onto the API router.
    return [{ source: '/v1/:path*', destination: '/api/v1/:path*' }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
