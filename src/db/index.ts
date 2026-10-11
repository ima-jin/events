import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
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
