import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside Next.js, so .env.local isn't auto-loaded — load it
// here rather than adding a `dotenv` dependency just for this one CLI path.
const envPath = '.env.local';
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (process.env[key]) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Generation needs no credential. Studio is confined to disposable test/CI databases;
// deployed baseline/migration operations use the vault-aware programmatic runners.
const testMode = process.env.CI === 'true' || process.env.NODE_ENV === 'test';
const testDatabaseUrl = testMode ? process.env.MIGRATIONS_TEST_DATABASE_URL : undefined;

const appSchemaName = process.env.APP_DB_SCHEMA;
if (!appSchemaName) {
  throw new Error('APP_DB_SCHEMA is not set — see .env.example and docs/MIGRATIONS.md.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: testDatabaseUrl ? { url: testDatabaseUrl } : undefined,
  schemaFilter: [appSchemaName],
  // Keep drizzle's own migration-tracking table inside this app's schema —
  // the default is a `drizzle` schema, which would be state outside what the
  // app owns (see docs/MIGRATIONS.md).
  migrations: {
    schema: appSchemaName,
  },
});
