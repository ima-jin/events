import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Same build-phase allowance as src/db/schema.ts: postgres.js connects lazily,
// so a placeholder URL is never dialled during `next build`.
const isNextBuild = process.env.NEXT_PHASE === 'phase-production-build';
const connectionString =
  process.env.DATABASE_URL ?? (isNextBuild ? 'postgres://build:build@localhost:5432/build' : undefined);
if (!connectionString) {
  throw new Error('DATABASE_URL is not set.');
}

const client = postgres(connectionString, { max: 1 });

export const db = drizzle(client, { schema });

/**
 * Raw postgres.js client for this app's own schema (`APP_DB_SCHEMA`) only —
 * for the handful of hand-written aggregate queries Drizzle can't express.
 * Never query kernel schemas through it; use `src/lib/kernel.ts` instead.
 */
export function getClient() {
  return client;
}
export * from './schema';
