import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSchema, BASELINE_HASH, BASELINE_WHEN, BaselineMismatchError,
  compareSchema, expectedSchema, readBaselineMigration, runBaseline, validateHistory,
} from '../../lib/migrate-baseline-core.mjs';
import { main } from '../../migrate-baseline.mjs';
const cli = main as unknown as (
  args: string[], env: Record<string, string>, connect?: unknown, logger?: unknown,
) => Promise<number>;

export const FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));
type Shape = Record<string, unknown>;
type Table = Shape & { columns: Record<string, Shape>; constraints: Shape[]; indexes: Shape[] };
export type Schema = Record<string, Table>;
const fresh = () => expectedSchema() as Schema;

export function catalogClient(schema: Schema, history: Shape[] = [], exists = true) {
  const tables = Object.entries(schema).map(([name, table]) => ({
    name, kind: table.kind, persistence: table.persistence, row_security: table.rowSecurity,
    force_row_security: table.forceRowSecurity, inherited: table.inherited,
  }));
  const columns: Shape[] = [];
  const indexes: Shape[] = [];
  const constraints: Shape[] = [];
  let oid = 1;
  const addIndex = (name: string, shape: Shape, indexName: string) => {
    const id = String(oid++);
    indexes.push({
      table_name: name, name: indexName, oid: id, ...shape,
      key_count: shape.keyCount, column_count: shape.columnCount, default_opclasses: shape.defaultOpclasses,
      default_collations: shape.defaultCollations, nulls_not_distinct: shape.nullsNotDistinct,
    });
    return id;
  };
  for (const [name, table] of Object.entries(schema)) {
    for (const [column, shape] of Object.entries(table.columns)) {
      columns.push({ table_name: name, name: column, ...shape, not_null: shape.notNull, default_expr: shape.default });
    }
    for (const index of table.indexes) addIndex(name, index, String(index.name));
    for (const constraint of table.constraints) {
      const indexOid = constraint.kind === 'f' ? '0' : addIndex(name, constraint.index as Shape, `${name}_key`);
      constraints.push({
        ...constraint, table_name: name, index_oid: indexOid,
        ref_schema: constraint.refSchema, ref_table: constraint.refTable, ref_columns: constraint.refColumns,
        on_delete: constraint.onDelete, on_update: constraint.onUpdate,
      });
    }
  }
  const unsafe = vi.fn(async (text: string) => {
    if (text.includes('pg_namespace WHERE')) return [{ exists }];
    if (text.includes('FROM pg_attribute a JOIN')) return columns;
    if (text.includes('FROM pg_index ix')) return indexes;
    if (text.includes('FROM pg_constraint con')) return constraints;
    if (text.includes('FROM pg_class c JOIN')) return tables;
    if (text.startsWith('SELECT hash')) return history;
    return [];
  });
  const tx = { unsafe };
  return { unsafe, begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx), end: vi.fn(async () => {}) };
}

export function trackingTable(): Table {
  const template = fresh().events;
  return {
    ...template,
    columns: {
      id: { type: 'integer', notNull: true, default: "nextval('events.__drizzle_migrations_id_seq'::regclass)", identity: '', generated: '' },
      hash: { type: 'text', notNull: true, default: null, identity: '', generated: '' },
      created_at: { type: 'bigint', notNull: false, default: null, identity: '', generated: '' },
    },
    constraints: [template.constraints.find((key) => key.kind === 'p')!],
    indexes: [],
  };
}

describe('pinned baseline and schema', () => {
  it('matches drizzle hashing and timestamp without changing SQL', async () => {
    const baseline = await readBaselineMigration(FOLDER);
    const [migration] = readMigrationFiles({ migrationsFolder: FOLDER });
    expect(baseline).toEqual({ tag: '0000_events_schema', hash: migration.hash, when: migration.folderMillis });
    expect(baseline.hash).toBe(BASELINE_HASH);
    expect(baseline.when).toBe(BASELINE_WHEN);
    expect(Object.keys(fresh())).toHaveLength(8);
    expect(compareSchema(fresh())).toEqual([]);
  });

  it.each(['', 'public', 'events;secret', 'EVENTS'])('refuses schema %s', (schema) => {
    expect(() => assertSchema(schema)).toThrow('APP_DB_SCHEMA must be events');
  });
  it('accepts only events', () => expect(assertSchema('events')).toBe('events'));

  it.each(['journal', 'sql'])('refuses modified %s', async (change) => {
    const folder = mkdtempSync(join(tmpdir(), 'events-baseline-'));
    mkdirSync(join(folder, 'meta'));
    const journal = change === 'journal' ? { entries: [] } : { entries: [{ tag: '0000_events_schema', when: BASELINE_WHEN }] };
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    writeFileSync(join(folder, '0000_events_schema.sql'), 'changed');
    await expect(readBaselineMigration(folder)).rejects.toBeInstanceOf(BaselineMismatchError);
  });

  it('rejects all column properties and extra/missing columns/tables', () => {
    const actual = fresh();
    actual.events.columns.id.type = 'integer';
    actual.events.columns.title.notNull = false;
    actual.events.columns.currency.default = null;
    delete actual.events.columns.did;
    actual.events.columns.extra = { type: 'text' };
    delete actual.pledges;
    actual.stray = fresh().pledges;
    expect(compareSchema(actual).join('\n')).toMatch(/columns mismatch/);
    expect(compareSchema(actual)).toContain('pledges: table missing');
    expect(compareSchema(actual)).toContain('stray: unexpected table');
  });

  it.each(['onDelete', 'onUpdate', 'refSchema', 'refColumns', 'match', 'validated', 'deferrable', 'deferred'])('rejects FK %s drift', (property) => {
    const actual = fresh();
    actual.orders.constraints.find((key) => key.kind === 'f')![property] = 'changed';
    expect(compareSchema(actual).join('\n')).toContain('constraints mismatch');
  });

  it.each(['kind', 'persistence', 'rowSecurity', 'forceRowSecurity', 'inherited'])('rejects table %s drift', (property) => {
    const actual = fresh();
    actual.events[property] = 'changed';
    expect(compareSchema(actual).join('\n')).toContain(`${property} mismatch`);
  });

  it.each(['unique', 'valid', 'ready', 'live', 'predicate', 'expressions', 'keys', 'method', 'options', 'keyCount', 'columnCount', 'defaultOpclasses', 'defaultCollations', 'nullsNotDistinct', 'immediate'])('rejects required index %s drift', (property) => {
    const actual = fresh();
    actual.events.indexes[0][property] = 'changed';
    expect(compareSchema(actual).join('\n')).toContain('required index');
  });

  it('checks PK/unique backing index semantics and tolerates extra indexes', () => {
    const actual = fresh();
    (actual.events.constraints[0].index as Shape).valid = false;
    expect(compareSchema(actual).join('\n')).toContain('constraints mismatch');
    actual.events.constraints = fresh().events.constraints.reverse();
    actual.events.indexes.push({ name: 'extra' });
    expect(compareSchema(actual)).toEqual([]);
  });
  it('rejects missing required index', () => {
    const actual = fresh();
    actual.events.indexes = [];
    expect(compareSchema(actual).join('\n')).toContain('required index');
  });
});

describe('runner transaction safety', () => {
  const options = { schema: 'events', migrationsFolder: FOLDER };
  const baseline = { hash: BASELINE_HASH, when: BASELINE_WHEN };
  const recorded = [{ hash: BASELINE_HASH, created_at: String(BASELINE_WHEN) }];

  it.each([
    [{ hash: 'unknown', created_at: BASELINE_WHEN }],
    [{ hash: BASELINE_HASH, created_at: 0 }],
    [{ hash: BASELINE_HASH, created_at: null }],
    [...recorded, ...recorded],
    [...recorded, { hash: 'other', created_at: BASELINE_WHEN + 1 }],
  ])('refuses unknown/ambiguous history %j', (...rows) => {
    expect(() => validateHistory(rows, baseline)).toThrow(BaselineMismatchError);
  });
  it('accepts empty history or one exact hash+timestamp pair', () => {
    expect(() => validateHistory([], baseline)).not.toThrow();
    expect(() => validateHistory(recorded, baseline)).not.toThrow();
  });
  it('fresh database creates nothing', async () => {
    const client = catalogClient({}, [], false);
    expect(await runBaseline(client, options)).toMatchObject({ status: 'fresh-database' });
    expect(client.unsafe.mock.calls.some(([text]) => /CREATE|INSERT/.test(text))).toBe(false);
  });
  it('dry run is transaction-read-only without DDL/DML', async () => {
    const client = catalogClient(fresh());
    expect(await runBaseline(client, { ...options, dryRun: true })).toMatchObject({ status: 'would-baseline' });
    expect(client.unsafe.mock.calls[0][0]).toBe('SET TRANSACTION READ ONLY');
    expect(client.unsafe.mock.calls.some(([text]) => /CREATE|INSERT|ALTER|DROP|TRUNCATE/.test(text))).toBe(false);
  });
  it('writes only tracking table and exact migration hash/timestamp', async () => {
    const client = catalogClient(fresh());
    expect(await runBaseline(client, options)).toMatchObject({ status: 'baselined' });
    expect(client.unsafe.mock.calls.map(([text]) => text).filter((text) => /CREATE|INSERT/.test(text))).toHaveLength(2);
    expect(client.unsafe).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO events.__drizzle_migrations'), [BASELINE_HASH, BASELINE_WHEN]);
  });
  it('validates schema on repeated runs and refuses drift before writes', async () => {
    const schema: Schema = { ...fresh(), __drizzle_migrations: trackingTable() };
    const client = catalogClient(schema, recorded);
    expect(await runBaseline(client, options)).toMatchObject({ status: 'already-baselined' });
    schema.events.columns.title.default = "'secret'";
    const drifted = catalogClient(schema, recorded);
    await expect(runBaseline(drifted, options)).rejects.toThrow('columns mismatch');
    expect(drifted.unsafe.mock.calls.some(([text]) => /CREATE|INSERT/.test(text))).toBe(false);
  });
  it('checks tracking shape and history before adopting', async () => {
    const schema = { ...fresh(), __drizzle_migrations: trackingTable() };
    await expect(runBaseline(catalogClient(schema, [{ hash: 'bad', created_at: BASELINE_WHEN }]), options)).rejects.toThrow('migration history');
    schema.__drizzle_migrations.columns.hash.notNull = false;
    await expect(runBaseline(catalogClient(schema), options)).rejects.toThrow('__drizzle_migrations: columns mismatch');
  });
});

describe('CLI secret-safe errors and statuses', () => {
  const env = { DATABASE_URL: 'postgres://sensitive:password@invalid/db' };
  const output = () => ({ log: vi.fn(), error: vi.fn() });
  it('does not echo arbitrary arguments, connection strings or driver errors', async () => {
    const logger = output();
    expect(await cli([env.DATABASE_URL], env, undefined, logger)).toBe(2);
    expect(await cli([], {}, undefined, logger)).toBe(2);
    expect(await cli([], { ...env, APP_DB_SCHEMA: 'other' }, undefined, logger)).toBe(2);
    const connect = () => { throw new Error(env.DATABASE_URL); };
    expect(await cli([], env, connect, logger)).toBe(2);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('password');
  });
  it.each(['fresh', 'dry', 'baseline', 'recorded', 'mismatch', 'connection'])('reports %s safely and closes client', async (mode) => {
    const schema = fresh();
    const history = mode === 'recorded' ? [{ hash: BASELINE_HASH, created_at: BASELINE_WHEN }] : [];
    if (mode === 'recorded') schema.__drizzle_migrations = trackingTable();
    if (mode === 'mismatch') delete schema.events;
    const client = catalogClient(schema, history, mode !== 'fresh');
    if (mode === 'connection') client.unsafe.mockRejectedValue(new Error(env.DATABASE_URL));
    client.end.mockRejectedValueOnce(new Error(env.DATABASE_URL));
    const logger = output();
    const result = await cli(mode === 'dry' ? ['--dry-run'] : [], env, () => client, logger);
    const expectedCode = { mismatch: 1, connection: 2 }[mode] ?? 0;
    expect(result).toBe(expectedCode);
    expect(client.end).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('password');
  });
  it('keeps migration SQL destructive operations out of baseline runtime', () => {
    const source = readFileSync(new URL('../../lib/migrate-baseline-core.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(DROP|ALTER|TRUNCATE)\b/);
  });
});
