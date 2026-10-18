#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertSchema, BaselineMismatchError, runBaseline } from './lib/migrate-baseline-core.mjs';
import { loadMigrationDatabaseUrl } from './lib/migration-credentials.mjs';

const MESSAGES = {
  baselined: 'Baselined 0000_events_schema. Next: pnpm db:migrate.',
  'already-baselined': 'Already baselined; schema and history validated. Nothing changed.',
  'fresh-database': 'Fresh database; nothing changed. Next: pnpm db:migrate.',
  'would-baseline': 'Dry run: schema matches; would record 0000_events_schema. Nothing changed.',
};

/**
 * Never print arbitrary arguments or driver errors: either may contain credentials.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export async function main(argv, env = process.env, connect = postgres, output = console) {
  if (argv.some((arg) => arg !== '--dry-run')) {
    output.error('Usage: migrate-baseline.mjs [--dry-run]');
    return 2;
  }
  let sql;
  try {
    const schema = assertSchema(env.APP_DB_SCHEMA || 'events');
    const databaseUrl = await loadMigrationDatabaseUrl(env);
    sql = connect(databaseUrl, { max: 1, onnotice: () => {} });
    const result = await runBaseline(sql, {
      schema, migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      dryRun: argv.includes('--dry-run'),
    });
    output.log(MESSAGES[result.status]);
    return 0;
  } catch (error) {
    if (error instanceof BaselineMismatchError) {
      output.error(error.message);
      output.error('Nothing changed. Reconcile the schema/history manually; do not force.');
      return 1;
    }
    output.error('Baseline failed: vault, configuration or database error. Verify the app keystore and /jin approvals. No credentials are printed.');
    return 2;
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
