import { appendFile, chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { generateEventKeypair } from '../../src/lib/event-keypair.mjs';
import { createScrubber, isPublicEvent, POLICY, SCRUB_VERSION, TABLES } from '../soak/policy.mjs';
import {
  argumentsFor, assertDirectory, assertTarget, catalog, connectionOptions, didMapping, endpoint,
  environment, hash, operatorPath, privateRead, Refusal, runCli, transaction,
} from '../soak/common.mjs';
import { exportData } from '../soak/export-prod-shaped.mjs';
import { loadData, validateManifest, visitRows } from '../soak/load-dev.mjs';
import { main as restoreMain, restoreArguments, restoreData, validateBackup } from '../soak/restore-dev.mjs';

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
const backup = 'events_soak_backup_fixture';

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
  for (const name of ['status', 'event_type', 'registration_status']) {
    if (row[name] !== undefined) row[name] = 'pending';
  }
  if (row.currency !== undefined) row.currency = 'CAD';
  if (table === 'events') Object.assign(row, { event_type: 'event', name_display_policy: 'attendee_choice' });
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
  Object.assign(rows.tickets[0], {
    owner_did: 'did:imajin:fixture-person', original_owner_did: 'did:imajin:fixture-person',
    signature: 'fixture_old_signature', status: 'used', used_at: '2026-01-02T00:00:00.000Z',
  });
  return rows;
}

/** Mock preserves transaction rollback and enforces the real Drizzle FK graph on inserts. */
function database(data: Rows = fixtureData(), source = true) {
  let state = structuredClone(data);
  let before = structuredClone(state);
  const backups: Rows[] = [];
  const client = {
    source, readOnly: 'on', drift: false, extraColumn: false, sequence: false, failInsert: '',
    actualDatabase: source ? 'fixture_source' : 'imajin_dev', behavior: '', precisionDrift: false,
    failSnapshot: false, onInsert: async () => {},
    retained: structuredClone(data), missingBackup: false, missingBackupColumn: false,
    batches: [] as number[], onLock: () => {},
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
          if (client.precisionDrift) Object.assign(result[0], { datetime_precision: 0, collation_name: 'fixture_changed_collation' });
          return result;
        }
        if (text.includes('pg_constraint') || text.includes('pg_indexes')) return [];
        if (text.includes('pg_inherits')) return TABLES.map((table_name) => ({
          table_name, relkind: 'r', relpersistence: 'p', relrowsecurity: false,
          relforcerowsecurity: false, relispartition: false, inherited: false,
          triggers: false, rules: false, ...(client.behavior ? { [client.behavior]: true } : {}),
        }));
        if (text.startsWith('CREATE SCHEMA')) backups.push(structuredClone(state));
        if (text.startsWith('CREATE TABLE') && client.failSnapshot) throw new Error('fixture snapshot failure');
        if (text.startsWith('LOCK TABLE')) client.onLock();
        if (text.startsWith('SELECT') && text.includes(`FROM "${backup}".`)) {
          if (client.missingBackup || client.missingBackupColumn) throw new Error('Retained snapshot unavailable.');
        }
        if (text.startsWith('TRUNCATE')) {
          expect(text).not.toContain('CASCADE');
          state = Object.fromEntries(TABLES.map((table) => [table, []]));
        }
        if (text.startsWith('INSERT')) {
          const table = /INSERT INTO "events"\."(\w+)"/.exec(text)![1];
          if (client.failInsert === table) throw new Error('fixture database error with values');
          const restored = text.includes(`FROM "${backup}".`);
          const rows = restored ? structuredClone(client.retained[table]) : [JSON.parse(params[0])];
          for (const row of rows) {
            for (const fk of getTableConfig(byName[table]).foreignKeys) {
              const ref = fk.reference();
              const value = row[ref.columns[0].name];
              if (value !== null) {
                expect(state[getTableConfig(ref.foreignTable).name].some((parent) => parent[ref.foreignColumns[0].name] === value)).toBe(true);
              }
            }
            state[table].push(row);
            await client.onInsert();
          }
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
          const projectedRows = data[table].map((row) => {
            const parent = table === 'ticket_types' ? data.events.find((event) => event.id === row.event_id) : row;
            const projected: Row = { ...row, __visible: parent ? isPublicEvent(parent) : false };
            if (table === 'events') {
              delete projected.private_key;
              delete projected.public_key;
            }
            return projected;
          });
          for (let offset = 0; offset < projectedRows.length; offset += size) {
            const batch = projectedRows.slice(offset, offset + size);
            client.batches.push(batch.length);
            yield batch;
          }
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
  const checkedColumns = [
    ['events', 'timezone', 'America/Toronto'], ['events', 'location_type', 'hybrid'],
    ['events', 'status', 'published'], ['events', 'event_type', 'campaign'],
    ['events', 'name_display_policy', 'attendee_choice'], ['events', 'access_mode', 'public'],
    ['events', 'currency', 'CAD'], ['ticket_types', 'currency', 'USD'],
    ['orders', 'currency', 'CAD'], ['orders', 'payment_method', 'stripe'], ['orders', 'status', 'pending'],
    ['tickets', 'currency', 'CAD'], ['tickets', 'payment_method', 'etransfer'],
    ['tickets', 'status', 'used'], ['tickets', 'registration_status', 'not_required'],
    ['ticket_queue', 'status', 'waiting'], ['pledges', 'status', 'confirmed'], ['pledges', 'currency', 'CAD'],
  ];

  it.each(checkedColumns)('preserves checked operational text in %s.%s', (table, column, value) => {
    const row = { ...fixtureData()[table][0], [column]: value };
    expect(hash(JSON.stringify(createScrubber()(table, row)[column]))).toBe(hash(JSON.stringify(value)));
    expect(createScrubber()(table, { ...row, [column]: null })[column]).toBeNull();
  });

  it.each(checkedColumns)('aborts export without exposing rejected text in %s.%s', async (table, column) => {
    const rows = fixtureData();
    const rejected = 'fixture sensitive rejected text';
    rows[table][0][column] = rejected;
    const source = database(rows);
    const directory = join(await mkdtemp(join(homedir(), 'soak-refusal-')), 'artifact');
    const output = logger();
    const failure = await exportData(source, { directory, sourceUrl }, output).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Error).message).toBe(`Unexpected keep value: ${table}.${column}.`);
    expect((failure as Error).message.includes(rejected)).toBe(false);
    expect(JSON.stringify(output.log.mock.calls).includes(rejected)).toBe(false);
    expect(source.unsafe.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    await expect(stat(join(directory, 'manifest.json'))).rejects.toThrow();
  });

  it('rejects malformed operational values without coercion or silent rewriting', () => {
    const scrub = createScrubber();
    const badValues: Record<string, unknown[]> = {
      timezone: ['Invalid/Zone', '', '+01:00', 42],
      currency: ['cad', ' CAD', 'CAD\n', 'US', 'USDD', 123],
      status: ['', 'UPPER', 'a'.repeat(33), 'pending\n', {}, 42],
      name_display_policy: ['unknown_policy'],
    };
    for (const [column, values] of Object.entries(badValues)) {
      for (const value of values) {
        expect(() => scrub('events', { ...fixtureData().events[0], [column]: value })).toThrow(Refusal);
      }
    }
    expect(hash(String(scrub('events', { ...fixtureData().events[0], timezone: 'UTC' }).timezone))).toBe(hash('UTC'));
  });

  it('normalizes email case and surrounding whitespace within one versioned export', async () => {
    const scrub = createScrubber();
    const row = fixtureData().orders[0];
    const normalized = scrub('orders', row).buyer_email;
    const variant = String(row.buyer_email).toUpperCase();
    expect(hash(String(scrub('orders', { ...row, buyer_email: ` \t${variant}\n` }).buyer_email))).toBe(hash(String(normalized)));
    const { directory, manifest } = await exported();
    expect(SCRUB_VERSION).toBe(2);
    expect(manifest.scrubMapVersion).toBe(SCRUB_VERSION);
    const target = database(fixtureData(), false);
    await expect(loadData(target, {
      directory, env, manifest: { ...manifest, scrubMapVersion: 1 }, commit: true,
    }, logger())).rejects.toThrow('scrub version');
    expect(target.unsafe).not.toHaveBeenCalled();
  });
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
  it('writes all 250 distinct rows exactly once across cursor batches with matching manifest bytes', async () => {
    const rows = fixtureData();
    rows.event_invites = Array.from({ length: 250 }, (_, index) => ({
      ...rows.event_invites[0], id: `fixture_invite_${index}`, token: `fixture_token_${index}`, used_count: index,
    }));
    const source = database(rows);
    const directory = join(await mkdtemp(join(homedir(), 'soak-batches-')), 'artifact');
    const manifest = await exportData(source, { directory, sourceUrl }, logger());
    expect(source.batches.filter((size) => size > 1)).toEqual([100, 100, 50]);
    const contents = await readFile(join(directory, 'event_invites.jsonl'), 'utf8');
    const written = contents.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(written).toHaveLength(250);
    expect(new Set(written.map((row) => row.id)).size).toBe(250);
    expect(new Set(written.map((row) => row.token)).size).toBe(250);
    expect(written.map((row) => row.used_count).every((value, index) => value === index)).toBe(true);
    expect(manifest.tables.event_invites).toEqual({
      count: 250, sha256: createHash('sha256').update(contents).digest('hex'),
    });
    await expect(visitRows(directory, 'event_invites', manifest.tables.event_invites)).resolves.toBeUndefined();
    const target = database(fixtureData(), false);
    await loadData(target, { directory, env, manifest, commit: true }, logger());
    expect(target.rows().event_invites).toHaveLength(250);
    expect(new Set(target.rows().event_invites.map((row) => row.id)).size).toBe(250);
  });
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
  it('detects precision and collation drift, not just column names/types', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.precisionDrift = true;
    await expect(loadData(target, { directory, env, manifest, commit: true }, logger())).rejects.toThrow('fingerprint mismatch');
    expect(target.backups).toHaveLength(0);
  });
  it('does not truncate or insert when snapshot creation fails', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.failSnapshot = true;
    await expect(loadData(target, { directory, env, manifest, commit: true }, logger())).rejects.toThrow('snapshot failure');
    expect(target.unsafe.mock.calls.some(([text]) => /^(TRUNCATE|INSERT)/.test(text))).toBe(false);
    expect(target.rows()).toEqual(fixtureData());
  });
  it('rolls back replacement if artifact bytes mutate after dry validation', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.onInsert = async () => {
      await appendFile(join(directory, 'tickets.jsonl'), ' ');
      target.onInsert = async () => {};
    };
    await expect(loadData(target, { directory, env, manifest, commit: true }, logger())).rejects.toThrow();
    expect(target.rows()).toEqual(fixtureData());
    expect(target.backups).toHaveLength(1);
  });
  it.each(['draft', 'invite_only'])('scrubs nonpublic event and tier text in the streaming export: %s', async (mode) => {
    const rows = fixtureData();
    if (mode === 'draft') rows.events[0].status = 'draft';
    else rows.events[0].access_mode = 'invite_only';
    rows.ticket_types[0].name = 'Private fixture tier';
    const directory = join(await mkdtemp(join(homedir(), 'soak-private-')), 'artifact');
    await exportData(database(rows), { directory, sourceUrl }, logger());
    expect(await readFile(join(directory, 'events.jsonl'), 'utf8')).not.toContain('Public fixture');
    expect(await readFile(join(directory, 'ticket_types.jsonl'), 'utf8')).not.toContain('Private fixture tier');
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

describe('guarded dev snapshot restore', () => {
  it('requires explicit options and a safe retained backup schema name', () => {
    const args = ['--target-env-file', 'file', '--in', 'directory', '--backup-schema-name', backup];
    expect(restoreArguments(args).commit).toBeUndefined();
    expect(restoreArguments([...args, '--commit']).commit).toBe(true);
    for (const invalid of ['', 'events', 'events_soak_backup_', `${backup}\n`, `${backup};DROP`, `${backup}"`, 'events_soak_backup_REPLACE_WITH_RETAINED_NAME', `events_soak_backup_${'x'.repeat(64)}`]) {
      expect(() => validateBackup(invalid)).toThrow('Invalid retained');
    }
    for (const invalid of [[], args.slice(0, 4), [...args, '--force'], [...args, '--url', sourceUrl]]) {
      expect(() => restoreArguments(invalid)).toThrow();
    }
  });

  it('defaults to a read-only dry run without advisory locks or writes', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    const output = logger();
    expect(await restoreData(target, { directory, env, manifest, backup }, output)).toEqual({ committed: false });
    expect(target.unsafe.mock.calls.every(([text]) => /^(SELECT|BEGIN TRANSACTION READ ONLY|COMMIT)/.test(text))).toBe(true);
    expect(target.unsafe.mock.calls.some(([text]) => text.includes('pg_advisory'))).toBe(false);
    expect(target.unsafe.mock.calls.filter(([text]) => text.includes('LIMIT 0'))).toHaveLength(TABLES.length);
    expect(JSON.stringify(output.log.mock.calls).includes('fixture')).toBe(false);
  });

  it('atomically restores exact previous dev rows and keys, retaining the backup unchanged', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.retained.events[0].title = 'Retained fixture';
    target.retained.events[0].private_key = 'retained-key-marker';
    const retained = structuredClone(target.retained);
    const output = logger();
    expect(await restoreData(target, { directory, env, manifest, backup, commit: true }, output)).toEqual({ committed: true });
    expect(hash(JSON.stringify(target.rows()))).toBe(hash(JSON.stringify(retained)));
    expect(hash(JSON.stringify(target.retained))).toBe(hash(JSON.stringify(retained)));
    const queries = target.unsafe.mock.calls.map(([text]) => text);
    expect(queries[0]).toBe('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
    expect(queries.at(-1)).toContain('pg_advisory_unlock');
    expect(queries.filter((text) => text.startsWith('BEGIN'))).toEqual([
      'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ',
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    ]);
    expect(queries.filter((text) => text === 'COMMIT')).toHaveLength(2);
    expect(queries.some((text) => text.includes('pg_advisory_lock'))).toBe(true);
    const truncate = queries.findIndex((text) => text.startsWith('TRUNCATE'));
    expect(queries.slice(0, truncate).filter((text) => text.includes('LIMIT 0'))).toHaveLength(TABLES.length * 2);
    expect(queries.slice(0, truncate).filter((text) => text.startsWith('LOCK TABLE'))).toHaveLength(2);
    const inserts = queries.filter((text) => text.startsWith('INSERT'));
    expect(inserts.map((text) => /INSERT INTO "events"\."(\w+)"/.exec(text)![1])).toEqual(TABLES);
    for (const [index, table] of TABLES.entries()) {
      for (const column of Object.keys(POLICY[table as keyof typeof POLICY])) {
        expect(inserts[index].includes(`"${column}"`)).toBe(true);
      }
    }
    expect(queries.join('\n')).not.toMatch(/CASCADE|SELECT \*|DROP|CREATE|__drizzle/);
    expect(JSON.stringify(output.log.mock.calls).includes('fixture')).toBe(false);
  });

  it('rolls back a partial restore and always releases the shared advisory lock', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.retained.events[0].title = 'Different retained fixture';
    const retained = structuredClone(target.retained);
    target.failInsert = 'tickets';
    await expect(restoreData(target, { directory, env, manifest, backup, commit: true }, logger())).rejects.toThrow();
    expect(hash(JSON.stringify(target.rows()))).toBe(hash(JSON.stringify(fixtureData())));
    expect(hash(JSON.stringify(target.retained))).toBe(hash(JSON.stringify(retained)));
    expect(target.unsafe.mock.calls.some(([text]) => text === 'ROLLBACK')).toBe(true);
    expect(target.unsafe.mock.calls.at(-1)![0]).toContain('pg_advisory_unlock');
  });

  it.each(['missingBackup', 'missingBackupColumn'] as const)('refuses %s before truncation in both modes', async (failure) => {
    const { directory, manifest } = await exported();
    for (const commit of [false, true]) {
      const target = database(fixtureData(), false);
      target[failure] = true;
      await expect(restoreData(target, { directory, env, manifest, backup, commit }, logger())).rejects.toThrow();
      expect(target.unsafe.mock.calls.some(([text]) => /^(TRUNCATE|INSERT)/.test(text))).toBe(false);
      expect(hash(JSON.stringify(target.rows()))).toBe(hash(JSON.stringify(fixtureData())));
    }
  });

  it('revalidates target catalog under exclusive locks before destructive SQL', async () => {
    const { directory, manifest } = await exported();
    const target = database(fixtureData(), false);
    target.onLock = () => { target.drift = true; };
    await expect(restoreData(target, { directory, env, manifest, backup, commit: true }, logger())).rejects.toThrow('fingerprint');
    expect(target.unsafe.mock.calls.some(([text]) => /^(TRUNCATE|INSERT)/.test(text))).toBe(false);
    expect(target.unsafe.mock.calls.at(-1)![0]).toContain('pg_advisory_unlock');
  });

  it('rejects source aliases, wrong actual databases, schema drift and non-read-only validation', async () => {
    const { directory, manifest } = await exported();
    const source = database();
    const wrong = database(fixtureData(), false);
    wrong.actualDatabase = 'wrong';
    const drift = database(fixtureData(), false);
    drift.drift = true;
    const writable = database(fixtureData(), false);
    writable.readOnly = 'off';
    for (const target of [source, wrong, drift, writable]) {
      await expect(restoreData(target, { directory, env, manifest, backup }, logger())).rejects.toThrow();
      expect(target.unsafe.mock.calls.some(([text]) => /^(TRUNCATE|INSERT)/.test(text))).toBe(false);
    }
  });

  it('checks private files, versions, paths and prod markers before connecting, and closes fixture clients', async () => {
    const { directory } = await exported();
    const file = join(await mkdtemp(join(homedir(), 'soak-restore-env-')), 'env');
    const devEnv = 'DATABASE_URL=postgres://fixture@dev.invalid/imajin_dev\nAPP_DB_SCHEMA=events\nIMAJIN_ENV=dev';
    await writeFile(file, devEnv, { mode: 0o600 });
    const target = database(fixtureData(), false);
    const release = vi.fn();
    const end = vi.fn();
    const reserve = vi.fn(async () => ({ ...target, release }));
    const connect = vi.fn(() => ({ reserve, end }));
    const args = ['--target-env-file', file, '--in', directory, '--backup-schema-name', backup];
    await restoreMain(args, logger(), connect);
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    connect.mockClear();
    await chmod(file, 0o644);
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow('0600');
    await chmod(file, 0o600);
    const link = `${file}-link`;
    await symlink(file, link);
    await expect(restoreMain(['--target-env-file', link, ...args.slice(2)], logger(), connect)).rejects.toThrow();
    for (const marker of ['IMAJIN_ENV', 'NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOY_ENV', 'NEXT_PUBLIC_IMAJIN_ENV']) {
      await writeFile(file, `${devEnv}\n${marker}=production`);
      await expect(restoreMain(args, logger(), connect)).rejects.toThrow('production marker');
    }
    await writeFile(file, devEnv.replace('imajin_dev', 'imajin_prod'));
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow('contains prod');
    await writeFile(file, devEnv.replace('IMAJIN_ENV=dev', 'IMAJIN_ENV='));
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow('explicit dev');
    await writeFile(file, devEnv);
    const manifestFile = join(directory, 'manifest.json');
    const originalManifest = await readFile(manifestFile, 'utf8');
    await chmod(manifestFile, 0o644);
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow('0600');
    await chmod(manifestFile, 0o600);
    await writeFile(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), scrubMapVersion: 1 }));
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow('scrub version');
    await writeFile(manifestFile, originalManifest);
    await chmod(directory, 0o755);
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow('0700');
    expect(connect).not.toHaveBeenCalled();
  });

  it('closes fixture clients on validation and reservation failure', async () => {
    const { directory } = await exported();
    const file = join(await mkdtemp(join(homedir(), 'soak-restore-close-')), 'env');
    await writeFile(file, 'DATABASE_URL=postgres://fixture@dev.invalid/imajin_dev\nAPP_DB_SCHEMA=events\nIMAJIN_ENV=dev', { mode: 0o600 });
    const args = ['--target-env-file', file, '--in', directory, '--backup-schema-name', backup];
    const target = database(fixtureData(), false);
    target.drift = true;
    const release = vi.fn();
    const end = vi.fn();
    const reserve = vi.fn(async () => ({ ...target, release }));
    const connect = () => ({ reserve, end });
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow('fingerprint');
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    reserve.mockRejectedValueOnce(new Error('Fixture connection unavailable.'));
    await expect(restoreMain(args, logger(), connect)).rejects.toThrow();
    expect(end).toHaveBeenCalledTimes(2);
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
