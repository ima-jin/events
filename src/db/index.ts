import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { getServerConfig } from '@/lib/vault-boot';

function createDatabase() {
  const { databaseUrl } = getServerConfig();
  const client = postgres(databaseUrl, { max: 1 });
  return { client, db: drizzle(client, { schema }) };
}

let database: ReturnType<typeof createDatabase> | undefined;

function getDatabase() {
  database ??= createDatabase();
  return database;
}

// Next's build imports route modules for discovery, without runtime credentials.
// A proxy delays construction until actual use; there is no build/env credential.
export const db = new Proxy({} as ReturnType<typeof createDatabase>['db'], {
  get(_target, property) {
    const current = getDatabase().db;
    const value = Reflect.get(current, property, current);
    return typeof value === 'function' ? value.bind(current) : value;
  },
});

/**
 * Raw postgres.js client for this app's own schema (`APP_DB_SCHEMA`) only —
 * for the handful of hand-written aggregate queries Drizzle can't express.
 * Never query kernel schemas through it; use `src/lib/kernel.ts` instead.
 */
export function getClient() {
  return getDatabase().client;
}
export * from './schema';
