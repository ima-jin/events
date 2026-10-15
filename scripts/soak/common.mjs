import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { POLICY, TABLES } from './policy.mjs';

export class Refusal extends Error {}
export const refuse = (condition, message) => {
  if (condition) throw new Refusal(message);
};
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
export const tableSql = (table, schema = 'events') => `${quote(schema)}.${quote(table)}`;
export const tableList = () => [...TABLES].reverse().map((table) => tableSql(table)).join(', ');
export const artifactColumns = (table) => Object.keys(POLICY[table]).filter((name) => POLICY[table][name] !== 'regenerate');
/** Only used for the fixed eight-table list: preserve FK order without concurrent transactions. */
export const inOrder = (items, work) => items.reduce((pending, item) => pending.then(() => work(item)), Promise.resolve());
/** Operator inputs stay beneath jin's home; canonicalize parents to reject symlink escapes. */
export async function operatorPath(path) {
  const root = await realpath(homedir());
  const candidate = resolve(root, path);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Refusal('Operator paths must stay beneath the operator home directory.');
  const parent = await realpath(dirname(candidate));
  const result = join(parent, basename(candidate));
  if (!result.startsWith(`${root}${sep}`)) throw new Refusal('Operator path parent escapes the home directory.');
  return result;
}

export async function privateRead(path) {
  const checked = await operatorPath(path);
  const root = await realpath(homedir());
  if (!checked.startsWith(`${root}${sep}`)) throw new Refusal('Input path escapes the home directory.');
  const file = await open(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    refuse(!stat.isFile() || (stat.mode & 0o777) !== 0o600, 'Input files must be regular files with mode 0600.');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function assertDirectory(path) {
  const checked = await operatorPath(path);
  const root = await realpath(homedir());
  if (!checked.startsWith(`${root}${sep}`)) throw new Refusal('Artifact path escapes the home directory.');
  const stat = await lstat(checked);
  refuse(!stat.isDirectory() || (stat.mode & 0o777) !== 0o700, 'Artifact directory must have mode 0700 and not be a symlink.');
}

export function endpoint(url) {
  const parsed = new URL(url);
  refuse(!['postgres:', 'postgresql:'].includes(parsed.protocol), 'DATABASE_URL must be a Postgres URL.');
  // Do not allow URL parameters to redirect the connection away from the checked endpoint.
  const allowed = new Set(['sslmode', 'connect_timeout', 'application_name']);
  refuse([...parsed.searchParams.keys()].some((key) => !allowed.has(key)), 'Unsupported DATABASE_URL parameters.');
  const database = decodeURIComponent(parsed.pathname.slice(1));
  refuse(!parsed.hostname || !database || !parsed.username, 'DATABASE_URL must specify host, role and database.');
  const identity = hash(JSON.stringify([parsed.hostname.toLowerCase(), parsed.port || '5432', database]));
  return { identity, database };
}

export async function environment(path) {
  const env = parseEnv(await privateRead(path));
  refuse(!env.DATABASE_URL || env.APP_DB_SCHEMA !== 'events', 'DATABASE_URL and APP_DB_SCHEMA=events are required in the env file.');
  endpoint(env.DATABASE_URL);
  return env;
}

export function assertTarget(env, manifest) {
  const target = endpoint(env.DATABASE_URL);
  refuse(target.identity === manifest.sourceEndpoint, 'Target matches the source endpoint.');
  refuse(target.database.toLowerCase().includes('prod'), 'Target database name contains prod.');
  for (const name of ['IMAJIN_ENV', 'NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOY_ENV', 'NEXT_PUBLIC_IMAJIN_ENV']) {
    refuse(/prod/i.test(env[name] || ''), 'Target env file contains a production marker.');
  }
  refuse(env.IMAJIN_ENV !== 'dev' || env.APP_DB_SCHEMA !== 'events'
    || target.database !== 'imajin_dev', 'Target must be explicit dev, database imajin_dev, schema events.');
}

export async function serverIdentity(sql) {
  const [row] = await sql.unsafe(`SELECT current_database() AS database,
    inet_server_addr()::text AS host, inet_server_port() AS port`);
  return { identity: hash(JSON.stringify([row.host, row.port, row.database])), database: row.database };
}

/** All transaction-control SQL is fixed, never derived from arguments or source rows. */
export async function transaction(sql, readOnly, work) {
  await sql.unsafe(readOnly
    ? 'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  try {
    if (readOnly) {
      const [row] = await sql.unsafe("SELECT current_setting('transaction_read_only') AS read_only");
      refuse(row.read_only !== 'on', 'Source/validation transaction is not read-only.');
    }
    const result = await work(sql);
    await sql.unsafe('COMMIT');
    return result;
  } catch (error) {
    await sql.unsafe('ROLLBACK');
    throw error;
  }
}

export async function catalog(sql) {
  const columns = await sql.unsafe(`SELECT table_name, column_name, data_type, udt_schema, udt_name,
    is_nullable, column_default, is_identity, is_generated, character_maximum_length,
    numeric_precision, numeric_scale, datetime_precision, collation_name, domain_schema, domain_name
    FROM information_schema.columns WHERE table_schema = 'events'
    AND table_name IN (${TABLES.map((table) => `'${table}'`).join(',')})
    ORDER BY table_name, ordinal_position`);
  for (const table of TABLES) {
    const actual = columns.filter((column) => column.table_name === table);
    const names = actual.map((column) => column.column_name).sort((a, b) => a.localeCompare(b));
    const expected = Object.keys(POLICY[table]).sort((a, b) => a.localeCompare(b));
    refuse(JSON.stringify(names) !== JSON.stringify(expected), 'Unclassified or missing schema columns.');
    refuse(actual.some((column) => column.is_identity !== 'NO'
      || column.is_generated !== 'NEVER' || /nextval\s*\(/i.test(column.column_default || '')),
    'Sequence/generated-column schema drift is unsupported; no sequences exist in the classified schema.');
  }
  const constraints = await sql.unsafe(`SELECT c.relname AS table_name, co.conname,
    pg_get_constraintdef(co.oid, true) AS definition
    FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'events' AND c.relname IN (${TABLES.map((table) => `'${table}'`).join(',')})
    ORDER BY c.relname, co.conname`);
  const indexes = await sql.unsafe(`SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'events' AND tablename IN (${TABLES.map((table) => `'${table}'`).join(',')})
    ORDER BY tablename, indexname`);
  const behavior = await sql.unsafe(`SELECT c.relname AS table_name, c.relkind, c.relpersistence,
    c.relrowsecurity, c.relforcerowsecurity, c.relispartition,
    EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid) AS inherited,
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
    EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.ev_class = c.oid AND r.rulename <> '_RETURN') AS rules
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'events' AND c.relname IN (${TABLES.map((table) => `'${table}'`).join(',')})
    ORDER BY c.relname`);
  refuse(behavior.length !== TABLES.length || behavior.some((table) => table.relkind !== 'r'
    || table.relpersistence !== 'p' || table.relrowsecurity || table.relforcerowsecurity
    || table.relispartition || table.inherited || table.triggers || table.rules),
  'Unsupported table behavior: RLS, triggers, rules, inheritance or non-ordinary tables.');
  return hash(JSON.stringify({
    columns: Array.from(columns), constraints: Array.from(constraints),
    indexes: Array.from(indexes), behavior: Array.from(behavior),
  }));
}

export async function connectFile(path, connect = postgres) {
  const env = await environment(path);
  const client = connect(env.DATABASE_URL, connectionOptions(env.DATABASE_URL));
  return { env, client };
}
/** Pin identity to the env-file URL, never ambient PGPORT/PGUSER/PGPASSWORD defaults. */
export function connectionOptions(url) {
  endpoint(url);
  const parsed = new URL(url);
  return {
    host: [parsed.hostname.replaceAll('[', '').replaceAll(']', '')],
    port: [Number(parsed.port || '5432')],
    database: decodeURIComponent(parsed.pathname.slice(1)),
    username: decodeURIComponent(parsed.username),
    password: () => decodeURIComponent(parsed.password),
    ssl: parsed.searchParams.get('sslmode') || false,
    connect_timeout: Number(parsed.searchParams.get('connect_timeout') || '30'),
    connection: { application_name: 'events-soak', search_path: 'pg_catalog', row_security: 'off' },
    max: 1, onnotice: () => {}, debug: false,
  };
}

export function argumentsFor(argv, exporting) {
  const options = exporting
    ? { 'source-env-file': { type: 'string' }, out: { type: 'string' }, 'did-map': { type: 'string' } }
    : { 'target-env-file': { type: 'string' }, in: { type: 'string' }, commit: { type: 'boolean' } };
  const { values } = parseArgs({ args: argv, options, allowPositionals: false, strict: true });
  const required = exporting ? ['source-env-file', 'out'] : ['target-env-file', 'in'];
  refuse(required.some((name) => !values[name]), 'Required command options are missing.');
  return values;
}

export async function didMapping(path) {
  if (!path) return Object.create(null);
  const mapping = JSON.parse(await privateRead(path));
  const did = /^did:imajin:[a-zA-Z0-9_-]+$/;
  refuse(!mapping || Array.isArray(mapping) || typeof mapping !== 'object', 'Invalid DID map.');
  const entries = Object.entries(mapping);
  refuse(entries.some(([from, to]) => !did.test(from) || typeof to !== 'string' || !did.test(to)), 'Invalid DID map.');
  refuse(new Set(entries.map(([, to]) => to)).size !== entries.length, 'DID map must not merge identities.');
  return Object.assign(Object.create(null), mapping);
}

export async function runCli(importUrl, argv, work, output = console) {
  if (process.argv[1] !== fileURLToPath(importUrl)) return;
  try {
    await work(argv, output);
  } catch (error) {
    // Driver/parser/filesystem errors can contain source values, paths or credentials.
    output.error(error instanceof Refusal ? error.message : 'Soak operation failed. Details withheld; no raw database errors are logged.');
    process.exitCode = 1;
  }
}

export async function readManifest(path) {
  return JSON.parse(await privateRead(path));
}
