import { mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  argumentsFor, artifactColumns, catalog, connectFile, didMapping, endpoint, quote,
  runCli, serverIdentity, tableSql, transaction,
} from './common.mjs';
import { createScrubber, isPublicEvent, SCRUB_VERSION, TABLES } from './policy.mjs';

function selection(table) {
  const columns = artifactColumns(table).map((column) => `t.${quote(column)}`).join(', ');
  let visible = 'false';
  if (table === 'events') visible = "(t.access_mode = 'public' AND t.status IN ('published','completed'))";
  if (table === 'ticket_types') visible = `(SELECT e.access_mode = 'public' AND e.status IN ('published','completed')
    FROM events.events e WHERE e.id = t.event_id)`;
  return `SELECT ${columns}, ${visible} AS __visible FROM ${tableSql(table)} t`;
}

async function writeTable(sql, table, directory, scrub) {
  const file = await open(join(directory, `${table}.jsonl`), 'wx', 0o600);
  const checksum = createHash('sha256');
  let count = 0;
  try {
    // Cursor batches bound raw data in memory. Scrub before writing a single byte.
    for await (const rows of sql.unsafe(selection(table)).cursor(100)) {
      for (const row of rows) {
        const visible = table === 'events' ? isPublicEvent(row) : row.__visible === true;
        const line = `${JSON.stringify(scrub(table, row, visible))}\n`;
        checksum.update(line);
        await file.writeFile(line);
        count++;
      }
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return { count, sha256: checksum.digest('hex') };
}

export async function exportData(sql, { directory, sourceUrl, mapping = Object.create(null) }, output = console) {
  await mkdir(directory, { mode: 0o700 }); // Refuse existing directories, including symlinks.
  const scrub = createScrubber(mapping);
  const manifest = await transaction(sql, true, async (tx) => {
    const schemaFingerprint = await catalog(tx);
    const sourceServer = await serverIdentity(tx);
    const tables = {};
    for (const table of TABLES) {
      tables[table] = await writeTable(tx, table, directory, scrub);
      output.log(`${table}: ${tables[table].count} rows scrubbed`);
    }
    return {
      formatVersion: 1, scrubMapVersion: SCRUB_VERSION, schema: 'events', schemaFingerprint,
      exportedAt: new Date().toISOString(), sourceEndpoint: endpoint(sourceUrl).identity, sourceServer, tables,
    };
  });
  // Only a complete, successfully committed read-only export receives a manifest.
  const file = await open(join(directory, 'manifest.json'), 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return manifest;
}

export async function main(argv, output = console) {
  const args = argumentsFor(argv, true);
  const mapping = await didMapping(args['did-map']);
  const { env, client } = await connectFile(args['source-env-file']);
  const sql = await client.reserve();
  try {
    await exportData(sql, { directory: args.out, sourceUrl: env.DATABASE_URL, mapping }, output);
  } finally {
    sql.release();
    await client.end({ timeout: 5 });
  }
}

await runCli(import.meta.url, process.argv.slice(2), main);
