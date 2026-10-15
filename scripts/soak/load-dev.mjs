import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import postgres from 'postgres';
import { generateEventKeypair } from '../../src/lib/event-keypair.mjs';
import {
  argumentsFor, artifactColumns, assertDirectory, assertTarget, catalog, connectionOptions, environment, inOrder,
  operatorPath, quote, readManifest, refuse, runCli, serverIdentity, tableList, tableSql, transaction,
} from './common.mjs';
import { POLICY, SCRUB_VERSION, TABLES } from './policy.mjs';

export function validateManifest(manifest) {
  refuse(manifest?.formatVersion !== 1 || manifest.scrubMapVersion !== SCRUB_VERSION
    || manifest.schema !== 'events', 'Unsupported manifest format, scrub version or schema.');
  for (const field of ['schemaFingerprint', 'sourceEndpoint', 'sourceServer']) {
    refuse(!/^[a-f0-9]{64}$/.test(manifest[field] || ''), 'Invalid manifest fingerprint.');
  }
  refuse(!Number.isFinite(Date.parse(manifest.exportedAt)), 'Invalid manifest timestamp.');
  refuse(JSON.stringify(Object.keys(manifest.tables || {}).sort()) !== JSON.stringify([...TABLES].sort()), 'Manifest must describe exactly the eight classified tables.');
  for (const table of TABLES) {
    const entry = manifest.tables[table];
    refuse(!entry || !Number.isSafeInteger(entry.count) || entry.count < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''), 'Invalid manifest counts or checksums.');
  }
}

export async function visitRows(directory, table, expected, visit = async () => {}) {
  directory = await operatorPath(directory);
  const file = await open(join(directory, `${table}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW);
  const checksum = createHash('sha256');
  let count = 0;
  try {
    const stat = await file.stat();
    refuse(!stat.isFile() || (stat.mode & 0o777) !== 0o600, 'Artifact files require mode 0600.');
    const stream = file.createReadStream({ autoClose: false });
    stream.on('data', (chunk) => checksum.update(chunk));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const row = JSON.parse(line);
        refuse(!row || Array.isArray(row) || typeof row !== 'object'
          || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(artifactColumns(table).sort()),
        'Artifact row has missing or unclassified columns.');
        await visit(row);
        count++;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    refuse(count !== expected.count || checksum.digest('hex') !== expected.sha256, 'Artifact count or checksum mismatch.');
  } finally {
    await file.close();
  }
}

export async function validateTarget(sql, env, manifest) {
  assertTarget(env, manifest);
  const server = await serverIdentity(sql);
  refuse(server.identity === manifest.sourceServer, 'Target resolves to the source server/database.');
  refuse(server.database !== 'imajin_dev', 'Connected target database must be imajin_dev.');
  refuse(await catalog(sql) !== manifest.schemaFingerprint, 'Schema fingerprint mismatch; no force override.');
}

async function snapshot(sql, backup) {
  await transaction(sql, false, async (tx) => {
    await tx.unsafe(`LOCK TABLE ${tableList()} IN ACCESS EXCLUSIVE MODE`);
    await tx.unsafe(`CREATE SCHEMA ${quote(backup)}`);
    await tx.unsafe(`REVOKE ALL ON SCHEMA ${quote(backup)} FROM PUBLIC`);
    await inOrder(TABLES, async (table) => {
      await tx.unsafe(`CREATE TABLE ${tableSql(table, backup)} AS TABLE ${tableSql(table)}`);
      await tx.unsafe(`REVOKE ALL ON TABLE ${tableSql(table, backup)} FROM PUBLIC`);
    });
  });
}

async function insertRow(sql, table, row) {
  if (table === 'events') {
    const pair = await generateEventKeypair();
    row = { ...row, private_key: pair.privateKey, public_key: pair.publicKey };
  }
  const columns = Object.keys(POLICY[table]).map(quote).join(', ');
  // PostgreSQL handles JSONB, timestamps and nullable typed columns, without string interpolation.
  await sql.unsafe(`INSERT INTO ${tableSql(table)} (${columns})
    SELECT ${columns} FROM jsonb_populate_record(NULL::${tableSql(table)}, $1::jsonb)`, [JSON.stringify(row)]);
}

export async function loadData(sql, { directory, env, manifest, commit = false }, output = console) {
  validateManifest(manifest);
  assertTarget(env, manifest);
  await assertDirectory(directory);
  await inOrder(TABLES, (table) => visitRows(directory, table, manifest.tables[table]));
  await transaction(sql, true, (tx) => validateTarget(tx, env, manifest));
  for (const table of TABLES) output.log(`${table}: ${manifest.tables[table].count} rows planned`);
  if (!commit) {
    output.log('Dry run: no snapshot, truncation or insert. Pass --commit to replace dev data.');
    return { committed: false };
  }
  // Serializes loaders; app/worker writers MUST be paused by the operator.
  await sql.unsafe("SELECT pg_advisory_lock(hashtext('events-soak-loader'))");
  const backup = `events_soak_backup_${Date.now()}_${randomUUID().slice(0, 8)}`;
  try {
    await transaction(sql, true, (tx) => validateTarget(tx, env, manifest));
    await snapshot(sql, backup);
    output.log(`Snapshot retained: ${backup}`);
    await transaction(sql, false, async (tx) => {
      await tx.unsafe(`LOCK TABLE ${tableList()} IN ACCESS EXCLUSIVE MODE`);
      await validateTarget(tx, env, manifest); // Recheck catalog under exclusive locks.
      await tx.unsafe(`TRUNCATE TABLE ${tableList()} RESTART IDENTITY`);
      await inOrder(TABLES, (table) => {
        // Revalidate bytes on the loading pass; any mutation rolls the entire load back.
        return visitRows(directory, table, manifest.tables[table], (row) => insertRow(tx, table, row));
      });
    });
    output.log('Committed: eight events tables replaced; snapshot retained.');
    return { committed: true, backup };
  } finally {
    await sql.unsafe("SELECT pg_advisory_unlock(hashtext('events-soak-loader'))");
  }
}

export async function main(argv, output = console) {
  const args = argumentsFor(argv, false);
  await assertDirectory(args.in);
  const manifest = await readManifest(join(args.in, 'manifest.json'));
  validateManifest(manifest);
  const env = await environment(args['target-env-file']);
  assertTarget(env, manifest); // Refuse unsafe targets before opening any connection.
  const client = postgres(env.DATABASE_URL, connectionOptions(env.DATABASE_URL));
  const sql = await client.reserve();
  try {
    await loadData(sql, { directory: args.in, env, manifest, commit: args.commit }, output);
  } finally {
    sql.release();
    await client.end({ timeout: 5 });
  }
}

await runCli(import.meta.url, process.argv.slice(2), main);
