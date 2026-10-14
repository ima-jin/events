import { createHash } from 'node:crypto';
import { readFile, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';

const read = promisify(readFile);
const snapshot = JSON.parse(readFileSync(new URL('../../migrations/meta/0000_snapshot.json', import.meta.url), 'utf8'));
export const BASELINE_HASH = '23b6c7eaaea9ee3a3296735728bc3b75ee88e22fa0ca80b4ab8e8e66dd2a187e';
export const BASELINE_WHEN = 1791305811029;
const TRACKING_TABLE = '__drizzle_migrations';

export class BaselineMismatchError extends Error {
  constructor(problems) {
    super(`Refusing to baseline:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'BaselineMismatchError';
  }
}

export function assertSchema(schema) {
  if (schema !== 'events') throw new Error('APP_DB_SCHEMA must be events.');
  return schema;
}

function indexShape(keys, unique = false) {
  return {
    keys, method: 'btree', unique, valid: true, ready: true, live: true,
    predicate: null, expressions: null, keyCount: keys.length, columnCount: keys.length,
    options: keys.map(() => 0), defaultOpclasses: true, defaultCollations: true,
    nullsNotDistinct: false, immediate: true,
  };
}

function keyShape(kind, columns) {
  return {
    kind, columns, validated: true, deferrable: false, deferred: false,
    index: indexShape(columns, true),
  };
}

function foreignKeyShape(fk) {
  return {
    kind: 'f', columns: fk.columnsFrom, refSchema: fk.schemaTo, refTable: fk.tableTo,
    refColumns: fk.columnsTo, onDelete: 'a', onUpdate: 'a', match: 's',
    validated: true, deferrable: false, deferred: false,
  };
}

function columnDefault(column) {
  if (column.default === undefined) return null;
  if (column.type === 'text') return `${column.default}::text`;
  return String(column.default);
}

/** Pinned snapshot of 0000, not the evolving application schema. */
export function expectedSchema() {
  const expected = {};
  for (const table of Object.values(snapshot.tables)) {
    const columns = {};
    for (const column of Object.values(table.columns)) {
      columns[column.name] = {
        type: column.type, notNull: column.notNull, default: columnDefault(column),
        identity: '', generated: '',
      };
    }
    const constraints = [
      keyShape('p', Object.values(table.columns).filter((column) => column.primaryKey).map((column) => column.name)),
      ...Object.values(table.uniqueConstraints).map((key) => keyShape('u', key.columns)),
      ...Object.values(table.foreignKeys).map(foreignKeyShape),
    ];
    const indexes = Object.values(table.indexes).map((index) => ({
      name: index.name, ...indexShape(index.columns.map((column) => column.expression), index.isUnique),
    }));
    expected[table.name] = {
      kind: 'r', persistence: 'p', rowSecurity: false, forceRowSecurity: false,
      inherited: false, columns, constraints, indexes,
    };
  }
  return expected;
}

const SQL_TABLES = `
 SELECT c.relname AS name, c.relkind::text AS kind, c.relpersistence::text AS persistence,
 c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
 EXISTS (SELECT 1 FROM pg_inherits inh WHERE inh.inhrelid = c.oid OR inh.inhparent = c.oid) AS inherited
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')`;
const SQL_COLUMNS = `
 SELECT c.relname AS table_name, a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
 a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default_expr,
 a.attidentity::text AS identity, a.attgenerated::text AS generated
 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
 JOIN pg_namespace n ON n.oid = c.relnamespace
 LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
 WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p')`;
const SQL_INDEXES = `
 SELECT t.relname AS table_name, i.relname AS name, i.oid::text AS oid, am.amname AS method,
 ix.indisunique AS unique, ix.indisvalid AS valid, ix.indisready AS ready, ix.indislive AS live,
 ix.indimmediate AS immediate, ix.indnullsnotdistinct AS nulls_not_distinct,
 ix.indnkeyatts AS key_count, ix.indnatts AS column_count,
 pg_get_expr(ix.indpred,ix.indrelid) AS predicate, pg_get_expr(ix.indexprs,ix.indrelid) AS expressions,
 ARRAY(SELECT COALESCE(a.attname::text,'<expression>') FROM
 unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
 LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord) AS keys,
 ARRAY(SELECT unnest(ix.indoption::smallint[])) AS options,
 (SELECT bool_and(opc.opcdefault) FROM unnest(ix.indclass::oid[]) op
 JOIN pg_opclass opc ON opc.oid = op) AS default_opclasses,
 (SELECT bool_and(coll = COALESCE(typ.typcollation,0)) FROM
 unnest(ix.indkey::smallint[],ix.indcollation::oid[]) k(attnum,coll)
 LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
 LEFT JOIN pg_type typ ON typ.oid = a.atttypid) AS default_collations
 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
 JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
 JOIN pg_am am ON am.oid = i.relam WHERE n.nspname = $1`;
const SQL_CONSTRAINTS = `
 SELECT c.relname AS table_name, con.contype::text AS kind, con.conindid::text AS index_oid,
 ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num,ord)
 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.num ORDER BY k.ord) AS columns,
 rn.nspname AS ref_schema, rc.relname AS ref_table,
 ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num,ord)
 JOIN pg_attribute a ON a.attrelid = rc.oid AND a.attnum = k.num ORDER BY k.ord) AS ref_columns,
 con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update, con.confmatchtype::text AS match,
 con.convalidated AS validated, con.condeferrable AS deferrable, con.condeferred AS deferred
 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
 JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_class rc ON rc.oid = con.confrelid
 LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace WHERE n.nspname = $1`;

function actualIndex(row) {
  return {
    keys: row.keys, method: row.method, unique: row.unique, valid: row.valid,
    ready: row.ready, live: row.live, predicate: row.predicate, expressions: row.expressions,
    keyCount: row.key_count, columnCount: row.column_count, options: row.options,
    defaultOpclasses: row.default_opclasses, defaultCollations: row.default_collations,
    nullsNotDistinct: row.nulls_not_distinct, immediate: row.immediate,
  };
}

function actualConstraint(row, indexes) {
  const constraint = {
    kind: row.kind, columns: row.columns, validated: row.validated,
    deferrable: row.deferrable, deferred: row.deferred,
  };
  if (row.kind === 'f') {
    return {
      ...constraint, refSchema: row.ref_schema, refTable: row.ref_table, refColumns: row.ref_columns,
      onDelete: row.on_delete, onUpdate: row.on_update, match: row.match,
    };
  }
  return { ...constraint, index: indexes.get(row.index_oid) };
}

/** All catalog queries are scoped to the events namespace; no app data is read. */
export async function introspectSchema(tx) {
  const actual = {};
  for (const row of await tx.unsafe(SQL_TABLES, ['events'])) {
    actual[row.name] = {
      kind: row.kind, persistence: row.persistence, rowSecurity: row.row_security,
      forceRowSecurity: row.force_row_security, inherited: row.inherited,
      columns: {}, constraints: [], indexes: [],
    };
  }
  for (const row of await tx.unsafe(SQL_COLUMNS, ['events'])) {
    actual[row.table_name].columns[row.name] = {
      type: row.type, notNull: row.not_null, default: row.default_expr,
      identity: row.identity, generated: row.generated,
    };
  }
  const indexes = new Map();
  for (const row of await tx.unsafe(SQL_INDEXES, ['events'])) {
    const shape = actualIndex(row);
    indexes.set(row.oid, shape);
    actual[row.table_name].indexes.push({ name: row.name, ...shape });
  }
  for (const row of await tx.unsafe(SQL_CONSTRAINTS, ['events'])) {
    actual[row.table_name].constraints.push(actualConstraint(row, indexes));
  }
  return actual;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const signature = (value) => JSON.stringify(canonical(value));
const constraintSignatures = (constraints) => constraints.map(signature).sort((a, b) => a.localeCompare(b));

function compareTable(name, actual, expected, problems) {
  for (const property of ['kind', 'persistence', 'rowSecurity', 'forceRowSecurity', 'inherited', 'columns']) {
    if (signature(actual[property]) !== signature(expected[property])) {
      problems.push(`${name}: ${property} mismatch`);
    }
  }
  if (signature(constraintSignatures(actual.constraints)) !== signature(constraintSignatures(expected.constraints))) {
    problems.push(`${name}: constraints mismatch (keys, FK targets/actions/properties)`);
  }
  for (const index of expected.indexes) {
    if (signature(actual.indexes.find((have) => have.name === index.name)) !== signature(index)) {
      problems.push(`${name}: required index ${index.name} mismatch`);
    }
  }
}

export function compareSchema(actual, expected = expectedSchema()) {
  const problems = [];
  for (const [name, table] of Object.entries(expected)) {
    if (actual[name]) compareTable(name, actual[name], table, problems);
    else problems.push(`${name}: table missing`);
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) problems.push(`${name}: unexpected table`);
  }
  return problems;
}

export async function readBaselineMigration(folder) {
  const journal = JSON.parse(await read(join(folder, 'meta/_journal.json'), 'utf8'));
  const entry = journal.entries?.[0];
  if (entry?.tag !== '0000_events_schema' || entry.when !== BASELINE_WHEN) {
    throw new BaselineMismatchError(['baseline journal does not match pinned 0000']);
  }
  const contents = await read(join(folder, '0000_events_schema.sql'), 'utf8');
  const hash = createHash('sha256').update(contents).digest('hex');
  if (hash !== BASELINE_HASH) throw new BaselineMismatchError(['baseline SQL hash changed']);
  return { tag: entry.tag, when: entry.when, hash };
}

function expectedTracking() {
  return {
    kind: 'r', persistence: 'p', rowSecurity: false, forceRowSecurity: false, inherited: false,
    columns: {
      id: { type: 'integer', notNull: true, default: "nextval('events.__drizzle_migrations_id_seq'::regclass)", identity: '', generated: '' },
      hash: { type: 'text', notNull: true, default: null, identity: '', generated: '' },
      created_at: { type: 'bigint', notNull: false, default: null, identity: '', generated: '' },
    },
    constraints: [keyShape('p', ['id'])], indexes: [],
  };
}

export function validateHistory(rows, baseline) {
  if (rows.length > 1 || rows.some((row) => row.hash !== baseline.hash || String(row.created_at) !== String(baseline.when))) {
    throw new BaselineMismatchError(['unknown, duplicate or mismatched migration history (hash AND timestamp required)']);
  }
}

export async function runBaseline(sql, options) {
  assertSchema(options.schema);
  const baseline = await readBaselineMigration(options.migrationsFolder);
  return sql.begin(async (tx) => {
    if (options.dryRun) await tx.unsafe('SET TRANSACTION READ ONLY');
    await tx.unsafe('SELECT pg_advisory_xact_lock($1)', [2518001]);
    const [{ exists }] = await tx.unsafe('SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists', ['events']);
    if (!exists) return { status: 'fresh-database', tag: baseline.tag };

    const actual = await introspectSchema(tx);
    const expected = expectedSchema();
    const trackingExists = TRACKING_TABLE in actual;
    if (trackingExists) expected[TRACKING_TABLE] = expectedTracking();
    const problems = compareSchema(actual, expected);
    if (problems.length > 0) throw new BaselineMismatchError(problems);
    const history = trackingExists
      ? await tx.unsafe('SELECT hash, created_at FROM events.__drizzle_migrations ORDER BY created_at')
      : [];
    validateHistory(history, baseline);
    if (history.length === 1) return { status: 'already-baselined', tag: baseline.tag };
    if (options.dryRun) return { status: 'would-baseline', tag: baseline.tag };
    await tx.unsafe('CREATE TABLE IF NOT EXISTS events.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    await tx.unsafe('INSERT INTO events.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [baseline.hash, baseline.when]);
    return { status: 'baselined', tag: baseline.tag };
  });
}
