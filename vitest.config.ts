import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // @ima-jin/auth-client transitively imports 'next/headers' (getSession's
      // cookie read) — not resolvable under plain-Node vitest, only inside a
      // real Next.js runtime. See test/stubs/next-headers.ts.
      // Same reason for next/server (imported by @ima-jin/logger + @ima-jin/auth):
      // the extensionless subpath is only resolvable by Next's own bundler.
      'next/server': fileURLToPath(new URL('./node_modules/next/server.js', import.meta.url)),
      'next/headers': fileURLToPath(new URL('./test/stubs/next-headers.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
    include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    server: {
      // Otherwise vitest hands @ima-jin/auth-client's ESM import of
      // 'next/headers' straight to Node's own resolver, which bypasses
      // resolve.alias above and can't find it outside a real Next.js runtime.
      deps: { inline: [/@ima-jin\//] },
    },
    coverage: {
      // lcov is what SonarCloud ingests (sonar.javascript.lcov.reportPaths).
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['app/**/*.ts', 'app/**/*.tsx', 'src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.d.ts',
        '**/.next/**',
        '**/node_modules/**',
      ],
    },
  },
});
