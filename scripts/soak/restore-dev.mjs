import { join } from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import {
  assertDirectory, assertTarget, connectionOptions, environment, inOrder, quote, readManifest, refuse,
  runCli, tableList, tableSql, transaction,
} from './common.mjs';
import { validateManifest, validateTarget } from './load-dev.mjs';
import { POLICY, TABLES } from './policy.mjs';

export function validateBackup(backup) {
  refuse(typeof backup !== 'string' || backup.trim() !== backup || backup.length > 63
    || backup === 'events_soak_backup_REPLACE_WITH_RETAINED_NAME'
    || !/^events_soak_backup_[A-Za-z\d_]+$/.test(backup),
    'Invalid retained backup schema name.');
}

export function restoreArguments(argv) {
  const { values } = parseArgs({
    args: argv, allowPositionals: false, strict: true,
    options: {
      'target-env-file': { type: 'string' }, in: { type: 'string' },
      'backup-schema-name': { type: 'string' }, commit: { type: 'boolean' },
    },
  });
  refuse(['target-env-file', 'in', 'backup-schema-name'].some((name) => !values[name]),
    'Required command options are missing.');
  validateBackup(values['backup-schema-name']);
  return values;
}

const columnsFor = (table) => Object.keys(POLICY[table]).map(quote).join(', ');

async function checkSnapshot(sql, backup) {
  // Validate every explicit column, including previous dev keys, before truncation.
  await inOrder(TABLES, (table) => sql.unsafe(
    `SELECT ${columnsFor(table)} FROM ${tableSql(table, backup)} LIMIT 0`,
  ));
}

async function restoreSnapshot(sql, env, manifest, backup) {
  await sql.unsafe(`LOCK TABLE ${tableList()} IN ACCESS EXCLUSIVE MODE`);
  await validateTarget(sql, env, manifest);
  const backupTables = TABLES.map((table) => tableSql(table, backup)).join(', ');
  await sql.unsafe(`LOCK TABLE ${backupTables} IN ACCESS EXCLUSIVE MODE`);
  await checkSnapshot(sql, backup);
  await sql.unsafe(`TRUNCATE TABLE ${tableList()} RESTART IDENTITY`);
  await inOrder(TABLES, (table) => {
    const columns = columnsFor(table);
    return sql.unsafe(`INSERT INTO ${tableSql(table)} (${columns})
      SELECT ${columns} FROM ${tableSql(table, backup)}`);
  });
}

export async function restoreData(sql, { directory, env, manifest, backup, commit = false }, output = console) {
  validateBackup(backup);
  validateManifest(manifest);
  assertTarget(env, manifest);
  await assertDirectory(directory);
  await transaction(sql, true, async (tx) => {
    await validateTarget(tx, env, manifest);
    await checkSnapshot(tx, backup);
  });
  if (!commit) {
    output.log('Dry run: retained snapshot validated; no rows changed. Pass --commit to restore dev data.');
    return { committed: false };
  }
  await sql.unsafe("SELECT pg_advisory_lock(hashtext('events-soak-loader'))");
  try {
    await transaction(sql, false, (tx) => restoreSnapshot(tx, env, manifest, backup));
    output.log('Restored previous dev rows; retained backup unchanged.');
    return { committed: true };
  } finally {
    await sql.unsafe("SELECT pg_advisory_unlock(hashtext('events-soak-loader'))");
  }
}

/**
 * @param {string[]} argv
 * @param {Pick<Console, 'log'>} output
 * @param {(url: string, options: ReturnType<typeof connectionOptions>) => {
 *   reserve: () => Promise<{ unsafe: (query: string) => Promise<unknown[]>, release: () => void }>,
 *   end: (options: { timeout: number }) => unknown
 * }} connect
 */
export async function main(argv, output = console, connect = postgres) {
  const args = restoreArguments(argv);
  await assertDirectory(args.in);
  const manifest = await readManifest(join(args.in, 'manifest.json'));
  validateManifest(manifest);
  const env = await environment(args['target-env-file']);
  assertTarget(env, manifest); // Refuse unsafe inputs before creating any connection.
  const client = connect(env.DATABASE_URL, connectionOptions(env.DATABASE_URL));
  try {
    const sql = await client.reserve();
    try {
      await restoreData(sql, {
        directory: args.in, env, manifest, backup: args['backup-schema-name'], commit: args.commit,
      }, output);
    } finally {
      sql.release();
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

await runCli(import.meta.url, process.argv.slice(2), main);
