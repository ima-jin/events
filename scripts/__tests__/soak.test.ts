import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { generateEventKeypair } from '../../src/lib/event-keypair.mjs';
import { createScrubber, isPublicEvent, POLICY, TABLES } from '../soak/policy.mjs';
import {
  argumentsFor, assertDirectory, assertTarget, catalog, connectionOptions, didMapping, endpoint,
  environment, operatorPath, privateRead, runCli, transaction,
} from '../soak/common.mjs';
import { exportData } from '../soak/export-prod-shaped.mjs';
import { loadData, validateManifest, visitRows } from '../soak/load-dev.mjs';

type Row = Record<string, unknown>;
type Rows = Record<string, Row[]>;
const tables = Object.values(schema).filter((value) => is(value, PgTable));
const byName = Object.fromEntries(tables.map((table) => [getTableConfig(table).name, table]));
const columns = tables.flatMap((table) => Object.values(getTableColumns(table)).map((column) => ({
  table_name: getTableConfig(table).name, column_name: column.name,
  data_type: column.dataType, udt_name: column.getSQLType(), is_nullable: column.notNull ? 'NO' : 'YES',
  column_default: null, is_identity: 'NO', is_generated: 'NEVER',
})));
const logger = () => ({ ...console, log: vi.fn(), error: vi.fn() });
const sourceUrl = 'postgres://fixture@source.invalid:5432/fixture_source';
const env = { DATABASE_URL: 'postgres://fixture@dev.invalid:5432/imajin_dev', APP_DB_SCHEMA: 'events', IMAJIN_ENV: 'dev' };

function fixtureRow(table: string): Row {
  const row = Object.fromEntries(Object.values(getTableColumns(byName[table])).map((column) => {
    let value: unknown = null;
    if (column.notNull) {
      value = 'fixture-text';
      if (column.dataType === 'number') value = 1;
      if (column.dataType === 'boolean') value = false;
      if (column.dataType === 'date') value = '2026-01-01T00:00:00.000Z';
      if (column.dataType === 'json') value = {};
    }
    return [column.name, value];
  }));
  row.id = `fixture_${table}`;
  for (const fk of getTableConfig(byName[table]).foreignKeys) {
    const ref = fk.reference();
    row[ref.columns[0].name] = `fixture_${getTableConfig(ref.foreignTable).name}`;
  }
  return row;
}

function fixtureData(): Rows {
  const rows = Object.fromEntries(TABLES.map((table) => [table, [fixtureRow(table)]]));
  Object.assign(rows.events[0], {
    did: 'did:imajin:fixture-event', creator_did: 'did:imajin:fixture-person',
    title: 'Public fixture', status: 'published', access_mode: 'public',
    public_key: 'source-public-marker', private_key: 'source-private-marker',
    metadata: { 'fixture-person@example.invalid': { phone: 'fixture phone', answers: ['fixture answer'], n: 42, b: true } },
    emt_email: 'fixture-person@example.invalid', virtual_url: 'https://fixture.invalid/private',
  });
  Object.assign(rows.orders[0], { buyer_did: 'did:imajin:fixture-person', buyer_email: 'fixture-person@example.invalid', payment_id: 'fixture_live_id' });
  Object.assign(rows.tickets[0], { owner_did: 'did:imajin:fixture-person', original_owner_did: 'did:imajin:fixture-person', signature: 'fixture_old_signature' });
  return rows;
}

/** Mock preserves transaction rollback and enforces the real Drizzle FK graph on inserts. */
function database(data: Rows = fixtureData(), source = true) {
  let state = structuredClone(data);
  let before = structuredClone(state);
  const backups: Rows[] = [];
  const client = {
    source, readOnly: 'on', drift: false, extraColumn: false, sequence: false, failInsert: '',
    actualDatabase: source ? 'fixture_source' : 'imajin_dev', behavior: '',
    unsafe: vi.fn((text: string, params: string[] = []) => {
      const execute = async () => {
        if (text.startsWith('BEGIN')) before = structuredClone(state);
        if (text === 'ROLLBACK') state = before;
        if (text.includes("current_setting('transaction_read_only')")) return [{ read_only: client.readOnly }];
        if (text.includes('current_database()')) return [{ database: client.actualDatabase, host: source ? '192.0.2.1' : '192.0.2.2', port: 5432 }];
        if (text.includes('information_schema.columns')) {
          const result = structuredClone(columns);
          if (client.extraColumn) result.push({ ...result[0], column_name: 'unclassified_pii' });
          if (client.sequence) result[0].column_default = "nextval('fixture')" as never;
          if (client.drift) result[0].udt_name = 'changed';
          return result;
        }
        if (text.includes('pg_constraint') || text.includes('pg_indexes')) return [];
        if (text.includes('pg_inherits')) return TABLES.map((table_name) => ({
          table_name, relkind: 'r', relpersistence: 'p', relrowsecurity: false,
          relforcerowsecurity: false, relispartition: false, inherited: false,
          triggers: false, rules: false, ...(client.behavior ? { [client.behavior]: true } : {}),
        }));
        if (text.startsWith('CREATE SCHEMA')) backups.push(structuredClone(state));
        if (text.startsWith('TRUNCATE')) {
          expect(text).not.toContain('CASCADE');
          state = Object.fromEntries(TABLES.map((table) => [table, []]));
        }
        if (text.startsWith('INSERT')) {
          const table = /INSERT INTO "events"\."(\w+)"/.exec(text)![1];
          if (client.failInsert === table) throw new Error('fixture database error with values');
          const row = JSON.parse(params[0]);
          for (const fk of getTableConfig(byName[table]).foreignKeys) {
            const ref = fk.reference();
            const value = row[ref.columns[0].name];
            if (value !== null) {
              expect(state[getTableConfig(ref.foreignTable).name].some((parent) => parent[ref.foreignColumns[0].name] === value)).toBe(true);
            }
          }
          state[table].push(row);
        }
        return [];
      };
      return Object.assign(execute(), {
        async *cursor(size: number) {
          expect(size).toBe(100);
          const table = /FROM "events"\."(\w+)" t/.exec(text)![1];
          // Simulate SELECT projection: key material is never even fetched.
          expect(text).not.toContain('private_key');
          expect(text).not.toContain('public_key');
          yield data[table].map((row) => {
            const projected: Row = { ...row, __visible: true };
            if (table === 'events') {
              delete projected.private_key;
              delete projected.public_key;
            }
            return projected;
          });
        },
      });
    }),
    rows: () => state,
    backups,
  };
  return client;
}

async function exported() {
  const directory = join(await mkdtemp(join(homedir(), 'events-soak-test-')), 'artifact');
  const source = database();
  const output = logger();
  const manifest = await exportData(source, { directory, sourceUrl }, output);
  return { directory, source, output, manifest };
}

describe('exhaustive scrub classification', () => {
  it('classifies exactly every real Drizzle table/column and fails closed on schema drift', async () => {
    expect(Object.keys(byName).sort()).toEqual([...TABLES].sort());
    for (const table of TABLES) {
      expect(Object.keys(POLICY[table as keyof typeof POLICY]).sort()).toEqual(Object.values(getTableColumns(byName[table])).map((column) => column.name).sort());
    }
    const client = database();
    client.extraColumn = true;
    await expect(catalog(client)).rejects.toThrow('Unclassified');
    client.extraColumn = false;
    client.sequence = true;
    await expect(catalog(client)).rejects.toThrow('Sequence');
  });

  it('uses one HMAC domain for IDs/FKs and DIDs, with fresh process-only salt each export', () => {
    const rows = fixtureData();
    const scrub = createScrubber();
    const event = scrub('events', rows.events[0]);
    const ticket = scrub('tickets', rows.tickets[0]);
    expect(ticket.event_id).toBe(event.id);
    expect(ticket.owner_did).toBe(event.creator_did);
    expect(ticket.original_owner_did).toBe(ticket.owner_did);
    expect(event.creator_did).toMatch(/^did:imajin:scrubbed-[a-f0-9]{64}$/);
    expect(scrub('events', rows.events[0])).toEqual(event);
    expect(createScrubber()('events', rows.events[0]).creator_did).not.toBe(event.creator_did);
    expect(event).not.toHaveProperty('private_key');
    expect(event).not.toHaveProperty('public_key');
  });

  it('covers email, payment, URL, signature, text, null and recursive JSON scrubbing', () => {
    const rows = fixtureData();
    const scrub = createScrubber();
    const event = scrub('events', rows.events[0]);
    expect(event.emt_email).toMatch(/^scrubbed\+[a-f0-9]{64}@example.invalid$/);
    expect(event.virtual_url).toBe('https://example.invalid/scrubbed');
    expect(event.ends_at).toBeNull();
    expect(event.title).toBe('x'.repeat(16));
    expect(event.metadata).toEqual({ field_0: { field_0: 'x'.repeat(16), field_1: ['x'.repeat(16)], field_2: 0, field_3: false } });
    expect(scrub('orders', rows.orders[0]).payment_id).toMatch(/^scrubbed_[a-f0-9]{64}$/);
    expect(scrub('tickets', rows.tickets[0]).signature).toBe('x'.repeat(24));
    const invite = { ...rows.event_invites[0], label: '' };
    expect(scrub('event_invites', invite).label).toBe('');
    expect(JSON.stringify(event)).not.toContain('fixture-person');
    expect(() => scrub('not_a_table', {})).toThrow('Unknown');
    expect(() => scrub('events', {})).toThrow('Missing');
  });

  it.each([
    ['public', 'published', true], ['public', 'completed', true],
    ['public', 'draft', false], ['invite_only', 'published', false], ['public', 'cancelled', false],
  ])('preserves public content only for %s %s', (access, status, visible) => {
    const row: Row = { ...fixtureData().events[0], access_mode: access, status };
    expect(isPublicEvent(row)).toBe(visible);
    expect(createScrubber()('events', row, isPublicEvent(row)).title).toBe(visible ? row.title : 'x'.repeat(16));
    const tier = { ...fixtureData().ticket_types[0], name: 'VIP fixture', perks: ['fixture perk'] };
    const scrubbed = createScrubber()('ticket_types', tier, visible);
    expect(scrubbed.name === tier.name).toBe(visible);
    expect(scrubbed.perks).toEqual(visible ? tier.perks : ['x'.repeat(16)]);
  });

  it('allowlists registration config and preserves only known operational fields', () => {
    const row = fixtureData().events[0];
    row.registration_config = { enforce_unique_emails: true, registration_deadline: '2026-01-01T00:00:00Z', phone: 'fixture private' };
    expect(createScrubber()('events', row).registration_config).toEqual({ enforce_unique_emails: true, registration_deadline: '2026-01-01T00:00:00Z' });
    row.registration_config = { registration_deadline: 'fixture private' };
    expect(createScrubber()('events', row).registration_config).toEqual({});
  });

  it('maps organizer and event DIDs consistently without touching unmapped identities', () => {
    const scrub = createScrubber({ 'did:imajin:fixture-person': 'did:imajin:dev-organizer', 'did:imajin:fixture-event': 'did:imajin:dev-event' });
    expect(scrub('events', fixtureData().events[0])).toMatchObject({ creator_did: 'did:imajin:dev-organizer', did: 'did:imajin:dev-event' });
    expect(scrub('tickets', fixtureData().tickets[0]).owner_did).toBe('did:imajin:dev-organizer');
  });
});

describe('read-only source and guarded loader round trip', () => {
  it('streams only scrubbed rows to private files and logs only counts', async () => {
    const result = await exported();
    expect((await stat(result.directory)).mode & 0o777).toBe(0o700);
    for (const table of [...TABLES, 'manifest']) {
      const file = join(result.directory, table === 'manifest' ? 'manifest.json' : `${table}.jsonl`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const contents = await readFile(file, 'utf8');
      expect(contents).not.toMatch(/source-private-marker|source-public-marker|fixture-person|fixture_live_id|fixture_old_signature/);
    }
    expect(result.source.unsafe.mock.calls[0][0]).toBe('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
    for (const [text] of result.source.unsafe.mock.calls) {
      expect(text).toMatch(/^(SELECT|BEGIN TRANSACTION READ ONLY|COMMIT)/);
      expect(text).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|CREATE|__drizzle/);
    }
    expect(JSON.stringify(result.output.log.mock.calls)).not.toContain('fixture');
    validateManifest(result.manifest);
    expect(result.manifest.tables.events.count).toBe(1);
  });

  it('refuses a source without enforced read-only and does not issue row SELECTs', async () => {
    const source = database();
    source.readOnly = 'off';
    const directory = join(await mkdtemp(join(homedir(), 'soak-ro-')), 'out');
    await expect(exportData(source, { directory, sourceUrl }, logger())).rejects.toThrow('not read-only');
    expect(source.unsafe.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ',
      "SELECT current_setting('transaction_read_only') AS read_only", 'ROLLBACK',
    ]);
    await expect(stat(join(directory, 'manifest.json'))).rejects.toThrow();
  });

  it('missing --commit is a read-only dry run with no snapshot/truncate/insert', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    expect(await loadData(target, { directory, env, manifest }, logger())).toEqual({ committed: false });
    expect(target.unsafe.mock.calls.every(([text]) => /^(SELECT|BEGIN TRANSACTION READ ONLY|COMMIT)/.test(text))).toBe(true);
    expect(target.backups).toHaveLength(0);
  });

  it('commits a retained snapshot before one atomic FK-consistent replacement, generates fresh event keys', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    const result = await loadData(target, { directory, env, manifest, commit: true }, logger());
    expect(result.committed).toBe(true);
    expect(result.backup).toMatch(/^events_soak_backup_\d+_[a-f0-9-]+$/);
    expect(target.backups[0]).toEqual(fixtureData());
    const queries = target.unsafe.mock.calls.map(([text]) => text);
    const snapshotIndex = queries.findIndex((text) => text.startsWith('CREATE SCHEMA'));
    const truncateIndex = queries.findIndex((text) => text.startsWith('TRUNCATE'));
    expect(queries.slice(snapshotIndex, truncateIndex)).toContain('COMMIT');
    expect(queries.slice(truncateIndex).filter((text) => text === 'COMMIT')).toHaveLength(1);
    const inserted = queries.filter((text) => text.startsWith('INSERT')).map((text) => /"events"\."(\w+)"/.exec(text)![1]);
    expect(inserted).toEqual(TABLES);
    expect(queries.join('\n')).not.toMatch(/CASCADE|__drizzle/);
    expect(queries[truncateIndex]).toContain('RESTART IDENTITY');
    const event = target.rows().events[0];
    expect(event.private_key).toMatch(/^[a-f0-9]{64}$/);
    expect(event.public_key).toMatch(/^[a-f0-9]{64}$/);
    expect(event.private_key).not.toBe(fixtureData().events[0].private_key);
    const ed = await import('@noble/ed25519');
    expect(Buffer.from(await ed.getPublicKey(Buffer.from(String(event.private_key), 'hex'))).toString('hex')).toBe(event.public_key);
    expect((await generateEventKeypair()).publicKey).not.toBe(event.public_key);
    expect(target.rows().tickets[0].used_at).toBe(fixtureData().tickets[0].used_at);
  });

  it('rolls back all imported rows on insert failure and retains pre-load dev data and snapshot', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.failInsert = 'tickets';
    await expect(loadData(target, { directory, env, manifest, commit: true }, logger())).rejects.toThrow('fixture database error');
    expect(target.rows()).toEqual(fixtureData());
    expect(target.backups).toHaveLength(1);
    expect(target.unsafe.mock.calls.some(([text]) => text === 'ROLLBACK')).toBe(true);
    expect(target.unsafe.mock.calls.at(-1)![0]).toContain('pg_advisory_unlock');
  });

  it('refuses fingerprint drift before any snapshot or data write', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.drift = true;
    await expect(loadData(target, { directory, env, manifest, commit: true }, logger())).rejects.toThrow('fingerprint mismatch');
    expect(target.backups).toHaveLength(0);
    expect(target.unsafe.mock.calls.some(([text]) => /^(CREATE|TRUNCATE|INSERT)/.test(text))).toBe(false);
  });

  it('detects an aliased source by server address, port and actual database', async () => {
    const { directory, manifest } = await exported();
    await expect(loadData(database(), { directory, env, manifest, commit: true }, logger())).rejects.toThrow('source server/database');
  });
  it('refuses a connected database that differs from the checked URL before writes', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.actualDatabase = 'fixture_wrong_database';
    await expect(loadData(target, { directory, env, manifest, commit: true }, logger())).rejects.toThrow('Connected target');
    expect(target.backups).toHaveLength(0);
  });
  it.each(['relrowsecurity', 'relforcerowsecurity', 'relispartition', 'inherited', 'triggers', 'rules'])('rejects unsupported table behavior %s before exporting data', async (behavior) => {
    const source = database();
    source.behavior = behavior;
    await expect(catalog(source)).rejects.toThrow('Unsupported table behavior');
  });
});

describe('configuration, manifest and artifact refusal paths', () => {
  it.each(['IMAJIN_ENV', 'NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOY_ENV', 'NEXT_PUBLIC_IMAJIN_ENV'])('rejects prod marker %s', (marker) => {
    expect(() => assertTarget({ ...env, [marker]: 'production' }, {})).toThrow('production marker');
  });
  it('rejects exact endpoints even across URL spelling/default port/credentials', () => {
    const sourceEndpoint = endpoint('postgresql://other@DEV.invalid/imajin_dev').identity;
    expect(() => assertTarget(env, { sourceEndpoint })).toThrow('matches the source');
  });
  it.each(['imajin_prod', 'PROD_backup', 'imajin_production_copy'])('rejects database %s', (databaseName) => {
    expect(() => assertTarget({ ...env, DATABASE_URL: `postgres://fixture@dev.invalid/${databaseName}` }, {})).toThrow('contains prod');
  });
  it.each([{ IMAJIN_ENV: '' }, { APP_DB_SCHEMA: 'public' }, { DATABASE_URL: 'postgres://fixture@dev.invalid/other' }])('rejects non-explicit dev target %j', (changes) => {
    expect(() => assertTarget({ ...env, ...changes }, {})).toThrow('explicit dev');
  });
  it.each(['postgres://fixture@dev.invalid/imajin_dev?host=source.invalid', 'http://dev.invalid/imajin_dev', 'postgres:///imajin_dev', 'postgres://dev.invalid/'])('rejects endpoint redirect/invalid URL %s', (url) => {
    expect(() => endpoint(url)).toThrow();
  });
  it('rejects unsupported CLI arguments and missing env files, never accepts inline URLs', () => {
    expect(() => argumentsFor(['--source-env-file', 'file', '--out', 'out'], true)).not.toThrow();
    expect(argumentsFor(['--target-env-file', 'file', '--in', 'out'], false).commit).toBeUndefined();
    for (const args of [[], ['--url', sourceUrl], ['--target-env-file', 'file', '--in', 'out', '--force']]) {
      expect(() => argumentsFor(args, false)).toThrow();
    }
  });
  it('pins all connection fields to the file URL, including empty-password and default port', () => {
    const options = connectionOptions(env.DATABASE_URL);
    expect(options.host).toEqual(['dev.invalid']);
    expect(options.port).toEqual([5432]);
    expect(options.username).toBe('fixture');
    expect(options.database).toBe('imajin_dev');
    expect(options.password()).toBe('');
    expect(connectionOptions('postgres://fixture@[::1]/imajin_dev').host).toEqual(['::1']);
    expect(connectionOptions('postgres://fixture@dev.invalid/imajin%5Fdev').database).toBe('imajin_dev');
    expect(() => connectionOptions('postgres://dev.invalid/imajin_dev')).toThrow('role');
  });
  it('reads only 0600 regular env/map files, not inherited env; rejects symlinks and DID collisions', async () => {
    const dir = await mkdtemp(join(homedir(), 'soak-env-'));
    const file = join(dir, 'env');
    await writeFile(file, 'DATABASE_URL=postgres://fixture@dev.invalid/imajin_dev\nAPP_DB_SCHEMA=events\nIMAJIN_ENV=dev', { mode: 0o600 });
    expect(await environment(file)).toEqual({ ...env, DATABASE_URL: 'postgres://fixture@dev.invalid/imajin_dev' });
    await chmod(file, 0o644);
    await expect(environment(file)).rejects.toThrow('0600');
    await chmod(file, 0o600);
    const link = join(dir, 'link');
    await symlink(file, link);
    await expect(privateRead(link)).rejects.toThrow();
    const map = join(dir, 'map');
    await writeFile(map, JSON.stringify({ 'did:imajin:source': 'did:imajin:dev' }), { mode: 0o600 });
    expect(await didMapping(map)).toEqual({ 'did:imajin:source': 'did:imajin:dev' });
    expect(await didMapping(undefined)).toEqual({});
    for (const value of [[], null, { bad: 'bad' }, { 'did:imajin:a': 'did:imajin:c', 'did:imajin:b': 'did:imajin:c' }]) {
      await writeFile(map, JSON.stringify(value));
      await expect(didMapping(map)).rejects.toThrow('DID map');
    }
    await writeFile(file, 'APP_DB_SCHEMA=events');
    await expect(environment(file)).rejects.toThrow('DATABASE_URL');
    await expect(assertDirectory(link)).rejects.toThrow('0700');
  });
  it('refuses traversal and symlink-parent escapes outside the operator home', async () => {
    await expect(operatorPath('/etc/passwd')).rejects.toThrow('home directory');
    const dir = await mkdtemp(join(homedir(), 'soak-path-'));
    const link = join(dir, 'escape');
    await symlink('/tmp', link);
    await expect(operatorPath(join(link, 'artifact'))).rejects.toThrow('escapes');
  });
  it('rejects invalid manifests, missing/extra columns, checksum/count changes and public artifact modes before writes', async () => {
    const { directory, manifest } = await exported();
    for (const change of [
      { formatVersion: 2 }, { scrubMapVersion: 99 }, { schema: 'public' },
      { sourceEndpoint: '' }, { sourceServer: '' }, { schemaFingerprint: '' },
      { exportedAt: 'invalid' }, { tables: {} },
      { tables: { ...manifest.tables, events: { count: -1, sha256: 'bad' } } },
    ]) expect(() => validateManifest({ ...manifest, ...change })).toThrow();
    const file = join(directory, 'events.jsonl');
    const line = await readFile(file, 'utf8');
    await expect(visitRows(directory, 'events', { ...manifest.tables.events, count: 2 })).rejects.toThrow('checksum mismatch');
    await expect(visitRows(directory, 'events', { ...manifest.tables.events, sha256: '0'.repeat(64) })).rejects.toThrow('checksum mismatch');
    await writeFile(file, `${JSON.stringify({ ...JSON.parse(line), unclassified: 'fixture' })}\n`);
    const target = database(fixtureData(), false);
    await expect(loadData(target, { directory, env, manifest, commit: true }, logger())).rejects.toThrow('unclassified');
    expect(target.unsafe).not.toHaveBeenCalled();
    await writeFile(file, line);
    await chmod(file, 0o644);
    await expect(visitRows(directory, 'events', manifest.tables.events)).rejects.toThrow('0600');
    await chmod(directory, 0o755);
    await expect(assertDirectory(directory)).rejects.toThrow('0700');
  });
  it('never logs arbitrary driver/argument errors or credentials', async () => {
    const original = process.argv[1];
    process.argv[1] = '/fixture-cli.mjs';
    const output = logger();
    try {
      await runCli('file:///fixture-cli.mjs', [], async () => { throw new Error('fixture_sensitive_driver_data'); }, output);
      expect(output.error.mock.calls.flat().join()).not.toContain('fixture_sensitive');
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv[1] = original;
      process.exitCode = 0;
    }
  });
  it('rolls back a failed read-only assertion', async () => {
    const db = database();
    db.readOnly = 'off';
    await expect(transaction(db, true, async () => {})).rejects.toThrow('read-only');
    expect(db.unsafe.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
});
