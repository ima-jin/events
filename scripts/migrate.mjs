#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { assertSchema } from './lib/migrate-baseline-core.mjs';
import { loadMigrationDatabaseUrl } from './lib/migration-credentials.mjs';

/** No CLI arguments or provider/driver errors are ever printed. */
export async function main(argv, env = process.env, connect = postgres, output = console) {
  if (argv.length > 0) {
    output.error('Usage: migrate.mjs');
    return 2;
  }
  let sql;
  try {
    const schema = assertSchema(env.APP_DB_SCHEMA || 'events');
    const databaseUrl = await loadMigrationDatabaseUrl(env);
    sql = connect(databaseUrl, { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      migrationsSchema: schema,
    });
    output.log('Events migrations applied; app schema only.');
    return 0;
  } catch {
    output.error('Migration failed: vault, configuration or database error. Verify the app keystore and /jin approvals. No credentials are printed.');
    return 2;
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
