#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  rmdirSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
import { ENV_NAMES } from '../check-env.mjs';
import { createReport, finishReport, timedCommand, timedPhase } from './rollback-report.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const REF = /^[a-f0-9]{40,64}$/;
const TAG = /^\d{4}_[a-zA-Z0-9_-]+$/;
class Refusal extends Error {}
const refuse = (message, decision) => {
  const error = new Refusal(message);
  error.decision = decision;
  throw error;
};
const privateFile = (file) => {
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
    refuse('Expected an operator-owned regular 0600 file; inspect permissions privately.');
  }
};

/** Capture both streams privately; never forward child output or driver errors. */
export function command(tool, args, options = {}) {
  const env = { ...process.env };
  for (const name of ENV_NAMES) delete env[name];
  const result = spawnSync(tool, args, {
    cwd: options.cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 300_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) refuse(`${options.step ?? 'Subprocess'} failed; inspect locally without sharing credentials.`);
  return result.stdout;
}

function tokens(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value;
  if (typeof value === 'string') return value.trim().split(/\s+/);
  refuse('Unsupported events process arguments.');
}

function listenerArguments(pm, context, cwd) {
  const args = tokens(pm.args);
  if (args.length !== 3 || args[0] !== 'start' ||
      !['-p', '--port'].includes(args[1]) || args[2] !== String(context.port)) {
    refuse('Unsupported events listener arguments; no arbitrary arguments are recorded.');
  }
  const nodeArgs = tokens(pm.node_args);
  const envFile = join(cwd, '.env.local');
  for (const arg of nodeArgs) {
    if (arg !== `--env-file=${envFile}` && !/^--max-old-space-size=\d+$/.test(arg)) {
      refuse('Unsupported events node arguments; no arbitrary arguments are recorded.');
    }
  }
  return { args, nodeArgs, envFile };
}

/** A strict allowlist, not a PM2 environment/dump serializer. */
export function definition(processes, context, expectedCwd) {
  if (!Array.isArray(processes)) refuse('Invalid private PM2 response.');
  const matches = processes.filter((app) => app.name === context.name);
  if (matches.length !== 1) refuse('Expected exactly one current events process.');
  const pm = matches[0].pm2_env;
  const cwd = pm?.pm_cwd;
  const exec = pm?.pm_exec_path;
  const allowed = [context.kernel, context.root];
  if (!allowed.includes(cwd) || (expectedCwd && cwd !== expectedCwd) ||
      exec !== join(cwd, 'node_modules/next/dist/bin/next')) {
    refuse('Unexpected events cwd/executable; record must precede cutover and target the kernel events copy.');
  }
  const { args, nodeArgs, envFile } = listenerArguments(pm, context, cwd);
  return { name: context.name, cwd, exec, args, node_args: nodeArgs, envFile, port: context.port };
}

export function migrationFiles(folder) {
  return readdirSync(folder).filter((name) => /^\d+_[a-zA-Z0-9_-]+\.sql$/.test(name)).map((name) => ({
    name: name.slice(0, -4),
    hash: createHash('sha256').update(readFileSync(join(folder, name))).digest('hex'),
  }));
}

/** Read only the app-owned tracking table, never kernel tables or application rows. */
export async function tracking(env, connect = postgres) {
  if (!env.DATABASE_URL || env.APP_DB_SCHEMA !== 'events') refuse('Missing events-only database configuration.');
  const sql = connect(env.DATABASE_URL, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    return await sql.begin('read only', async (tx) => {
      const [{ present }] = await tx`SELECT to_regclass('events.__drizzle_migrations') IS NOT NULL AS present`;
      if (!present) return [];
      const rows = await tx`SELECT hash FROM events.__drizzle_migrations ORDER BY id`;
      if (rows.some((row) => !HASH.test(row.hash))) refuse('Invalid events migration tracking hash.');
      return rows.map((row) => row.hash);
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

function readEnv(file) {
  privateFile(file);
  return parseEnv(readFileSync(file, 'utf8'));
}

function publicHealth(env) {
  const url = new URL(env.NEXT_PUBLIC_EVENTS_URL || env.NEXT_PUBLIC_APP_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['/events', '/events/'].includes(url.pathname)) refuse('Invalid public events URL in env file.');
  return `${url.origin}/events/api/health`;
}

function readRecord(context) {
  const files = readdirSync(context.directory).filter((name) =>
    new RegExp(String.raw`^events-rollback-${context.target}-[0-9T_Z-]+\.json$`).test(name)).sort();
  if (files.length === 0) return undefined;
  const file = join(context.directory, files.at(-1));
  privateFile(file);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.version !== 1 || record.target !== context.target ||
      !REF.test(record.standaloneRef) || !Array.isArray(record.migrations) ||
      record.migrations.some((item) => !HASH.test(item.hash) ||
        (item.name !== null && !TAG.test(item.name)))) refuse('Invalid saved rollback record.');
  const source = recordSource(record, context);
  const saved = record.process;
  const checked = definition([{ name: saved?.name, pm2_env: {
    pm_cwd: saved?.cwd, pm_exec_path: saved?.exec, args: saved?.args, node_args: saved?.node_args,
  } }], context, context.kernel);
  if (JSON.stringify(saved) !== JSON.stringify(checked)) refuse('Invalid saved events definition.');
  if (source === 'post-cutover-synthesized' &&
      JSON.stringify(saved) !== JSON.stringify(canonicalProcess(context, context.kernel))) {
    refuse('Invalid synthesized kernel destination; canonical fields are required.');
  }
  return record;
}
function recordSource(record, context) {
  const source = record.source ?? 'observed';
  if (source === 'observed' || (source === 'post-cutover-synthesized' && context.target === 'dev')) return source;
  refuse('Invalid rollback record source; synthesized records are dev-only.');
}

function current(context, run) {
  const processes = JSON.parse(run('pm2', ['jlist'], { step: 'Private PM2 inspection' }));
  if (!Array.isArray(processes)) refuse('Invalid private PM2 response.');
  if (processes.some((app) => app.name === context.name)) return definition(processes, context);
  return undefined;
}
function removeEvents(context, run, step) {
  if (current(context, run)) run('pm2', ['delete', context.name], { step });
}

export function checkMigrations(record, hashes, known) {
  const before = new Set(record.migrations.map((item) => item.hash));
  if ([...before].some((hash) => !hashes.includes(hash))) refuse('Migration history shrank since recording; reconcile manually. No force bypass.');
  const available = new Set(known.map((item) => item.hash));
  const unknown = [...new Set(hashes)].filter((hash) => !before.has(hash) && !available.has(hash));
  if (unknown.length > 0) refuse(`Post-record migrations unknown to kernel copy: ${unknown.join(', ')}. Refusing rollback; no force bypass.`);
}

function preflightKernelBuild(context) {
  if (!existsSync(join(context.kernel, '.next/BUILD_ID'))) {
    refuse(`DECISION #2804: Kernel events .next/BUILD_ID missing (#2804). Before retrying, the kernel operator must build apps/events from ~/${context.target}/imajin-ai with that environment's approved kernel build procedure (pnpm --filter @imajin/events build), preserving its env and secrets. Operator approval is required; nothing was changed.`, {
      code: '#2804', status: 'operator-decision-required', prerequisite: 'approved-kernel-events-build',
    });
  }
}

function preflightRollback(context, record, hashes) {
  checkMigrations(record, hashes, migrationFiles(join(context.home, context.target, 'imajin-ai/migrations')));
  if (!existsSync(record.process.exec)) refuse('Saved kernel events executable missing; operator must restore dependencies before rollback.');
  privateFile(record.process.envFile);
}

function preflightForward(context, record, run) {
  for (const tool of ['git', 'node', 'pnpm', 'pm2', 'curl']) {
    run('bash', ['-c', 'command -v "$1" >/dev/null', '--', tool], { step: 'Required tool check' });
  }
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: context.root }).trim()) {
    refuse('Tracked standalone files must be clean before rehearsal.');
  }
  run('git', ['cat-file', '-e', `${record.standaloneRef}:scripts/deploy.sh`], { cwd: context.root, step: 'Recorded deploy ref check' });
  run('node', ['scripts/check-env.mjs', context.target], { cwd: context.root, step: 'Standalone environment preflight' });
  if (!existsSync(join(context.root, 'ecosystem.config.cjs'))) refuse('Standalone ecosystem file missing.');
}

function probeHealth(run, url) {
  try {
    const response = JSON.parse(run('curl', ['--fail', '--silent', '--max-time', '5', url], {
      timeout: 6_000, step: 'Private health check',
    }));
    return response.status === 'ok' && ['events', 'imajin-events'].includes(response.service);
  } catch {
    return false; // Response bodies and curl errors remain private.
  }
}

async function awaitHealthy(run, url, sleep, attempt = 1) {
  if (probeHealth(run, url)) return true;
  if (attempt >= 30) return false;
  await sleep(2_000);
  return awaitHealthy(run, url, sleep, attempt + 1);
}

async function checkEndpoints(endpoints, context, run, output, sleep, started) {
  if (endpoints.length === 0) return;
  const [[label, url], ...remaining] = endpoints;
  await timedPhase(context.report, `${label} health`, async () => {
    if (!await awaitHealthy(run, url, sleep)) refuse(`${label} events health failed after ${Date.now() - started}ms; stop and inspect privately.`);
  });
  output.log(`${label} events health ok; elapsed ${Date.now() - started}ms.`);
  await checkEndpoints(remaining, context, run, output, sleep, started);
}

export async function health(context, run, output, sleep = (ms) => new Promise((done) => setTimeout(done, ms))) {
  const started = Date.now();
  const endpoints = [
    ['loopback', `http://127.0.0.1:${context.port}/events/api/health`], ['public', context.publicUrl],
  ];
  await checkEndpoints(endpoints, context, run, output, sleep, started);
}

function startSaved(context, record, run) {
  // No ecosystem file containing the PM2 response is ever written.
  const saved = record.process;
  run('pm2', ['start', saved.exec, '--name', saved.name, '--cwd', saved.cwd,
    '--interpreter', 'node', '--node-args', saved.node_args.join(' '), '--',
    ...saved.args], { step: 'Start saved kernel events definition' });
  run('pm2', ['save'], { step: 'Persist events rollback' });
}

async function restoreStandalone(context, record, run, output, sleep) {
  // deploy.sh rightly refuses a stale kernel definition. Only remove events,
  // after preflights and immediately before invoking the existing deploy path.
  preflightForward(context, record, run);
  removeEvents(context, run, 'Remove events for roll-forward');
  run('pm2', ['save'], { step: 'Persist roll-forward boundary' });
  run('bash', ['scripts/deploy.sh', context.target, record.standaloneRef], {
    cwd: context.root, timeout: 30 * 60_000, step: 'Recorded standalone deployment',
  });
  const running = current(context, run);
  if (running?.cwd !== context.root) refuse('Roll-forward did not restore standalone events.');
  await health(context, run, output, sleep);
}

function canonicalProcess(context, cwd) {
  const envFile = join(cwd, '.env.local');
  return {
    name: context.name, cwd, exec: join(cwd, 'node_modules/next/dist/bin/next'),
    args: ['start', '-p', String(context.port)], node_args: [`--env-file=${envFile}`],
    envFile, port: context.port,
  };
}

function recordDefinition(context, run, postCutover) {
  const processes = JSON.parse(run('pm2', ['jlist'], { step: 'Private PM2 inspection' }));
  if (postCutover) {
    const observed = definition(processes, context, context.root);
    if (JSON.stringify(observed) !== JSON.stringify(canonicalProcess(context, context.root))) {
      refuse('Post-cutover recording requires the exact standalone events definition.');
    }
    preflightKernelBuild(context);
    const destination = canonicalProcess(context, context.kernel);
    if (!existsSync(destination.exec)) refuse('Canonical kernel events executable missing; restore dependencies before recording.');
    privateFile(destination.envFile); // Metadata only: never read the kernel env values.
    return destination;
  }
  return definition(processes, context, context.kernel);
}

async function saveRecord(context, run, readTracking, output, postCutover = false) {
  const process = recordDefinition(context, run, postCutover);
  privateFile(process.envFile);
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: context.root }).trim()) {
    refuse('Tracked standalone files must be clean before recording a reproducible ref.');
  }
  const standaloneRef = run('git', ['rev-parse', 'HEAD'], { cwd: context.root, step: 'Standalone ref capture' }).trim();
  if (!REF.test(standaloneRef)) refuse('Invalid standalone commit ref.');
  const known = migrationFiles(join(context.root, 'migrations'));
  const hashes = await readTracking(context.env);
  const migrations = hashes.map((hash) => ({ hash, name: known.find((item) => item.hash === hash)?.name ?? null }));
  const createdAt = new Date().toISOString();
  const source = postCutover ? 'post-cutover-synthesized' : 'observed';
  const record = { version: 1, target: context.target, createdAt, standaloneRef, process, migrations, source };
  const timestamp = createdAt.replaceAll(':', '-').replaceAll('.', '_');
  writeFileSync(join(context.directory, `events-rollback-${context.target}-${timestamp}.json`),
    `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  output.log(`Private ${source} events record saved (0600); ${migrations.length} tracking hashes.`);
  return record;
}

function invocation(argv) {
  const [target, action, flag] = argv;
  const postCutover = flag === '--post-cutover';
  const validLength = argv.length === 2 || (argv.length === 3 && postCutover && action === 'record');
  if (!validLength || !['dev', 'prod'].includes(target) || !['record', 'rollback', 'rehearse'].includes(action)) {
    refuse('Usage: bash scripts/soak/rollback.sh <dev|prod> <record|rollback|rehearse> [--post-cutover (dev record only)]');
  }
  if (postCutover && target !== 'dev') refuse('Post-cutover recording is dev-only; prod must record before cutover. No force bypass.');
  if (target === 'prod' && action === 'rehearse') refuse('Rehearsal is dev-only; prod rehearsal is refused.');
  if (Number(process.versions.node.split('.')[0]) < 22) refuse('Node 22+ required.');
  return { target, action, postCutover };
}

function createContext(target, dependencies) {
  const home = dependencies.home ?? homedir();
  const root = resolve(dependencies.root ?? ROOT);
  if (realpathSync(root) !== join(home, target, 'events')) refuse('Run only from the canonical ~/<env>/events checkout.');
  const directory = join(home, '.imajin');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    refuse('~/.imajin must be an operator-owned private directory (0700).');
  }
  const env = readEnv(join(root, '.env.local'));
  return {
    home, root, target, directory, env, name: `${target}-events`,
    kernel: join(home, target, 'imajin-ai/apps/events'),
    port: target === 'dev' ? 3006 : 7006, publicUrl: publicHealth(env),
  };
}

function acquireLock(context) {
  const lock = join(context.directory, `events-rollback-${context.target}.lock`);
  try {
    mkdirSync(lock, { mode: 0o700 });
    return lock;
  } catch { refuse('Another rollback operation or stale lock exists; inspect privately before retrying.'); }
}

async function recoverStandalone(context, record, run, output, sleep) {
  output.error('Rehearsal failed after process transition; attempting recorded standalone recovery.');
  try {
    await restoreStandalone(context, record, run, output, sleep);
    output.error('Recorded standalone recovery succeeded; rehearsal still failed. Review timings and private logs.');
  } catch {
    output.error('Standalone recovery failed. Stop cutover; preserve the record and data. Inspect events privately, then retry the recorded standalone deployment or approved kernel restore. No other process was changed.');
  }
}

async function transition(context, record, action, dependencies) {
  const { run, output, sleep } = dependencies;
  output.log('Rollback consequences: tickets issued with the standalone NEW QR secret will not verify on the kernel copy; no reissue. Existing pre-cutover ticket QRs may verify again on kernel. The new standalone app identity may fail under kernel code; paid flows fail closed if the kernel copy lacks the claimed identity. Do not copy secrets or replace identities.');
  const started = Date.now();
  try {
    removeEvents(context, run, 'Remove current events');
    startSaved(context, record, run);
    await health(context, run, output, sleep);
    output.log(`Kernel events restored and saved; elapsed ${Date.now() - started}ms.`);
    if (action === 'rehearse') {
      await restoreStandalone(context, record, run, output, sleep);
      output.log(`Rehearsal complete; standalone events restored; total ${Date.now() - started}ms.`);
    }
  } catch (error) {
    if (action === 'rehearse') await recoverStandalone(context, record, run, output, sleep);
    throw error;
  }
}

async function execute(context, action, dependencies, postCutover) {
  const { run, readTracking, output } = dependencies;
  if (action === 'record') {
    await saveRecord(context, run, readTracking, output, postCutover);
    return;
  }
  let record = readRecord(context);
  if (!record && action === 'rehearse') record = await saveRecord(context, run, readTracking, output);
  if (!record) refuse('No pre-cutover rollback record. Record the current kernel events definition before cutover; no force bypass.');
  if (context.report) context.report.data.source = recordSource(record, context);
  for (const tool of ['pm2', 'curl']) {
    run('bash', ['-c', 'command -v "$1" >/dev/null', '--', tool], { step: 'Rollback tool preflight' });
  }
  current(context, run); // Refuse unknown/duplicate processes before any mutation.
  await timedPhase(context.report, 'rollback preflight', async () => {
    preflightKernelBuild(context);
    preflightRollback(context, record, await readTracking(context.env));
  });
  if (action === 'rehearse') preflightForward(context, record, run);
  await transition(context, record, action, dependencies);
}

function releaseLock(lock, output) {
  if (lock) {
    try {
      rmdirSync(lock);
    } catch {
      output.error('Could not release events rollback lock; inspect privately before retrying.');
    }
  }
}

function persistReport(report, result, decision, output) {
  try {
    finishReport(report, result, decision);
    if (report) output.log('Private rehearsal timing report saved (0600) under ~/.imajin.');
    return result;
  } catch {
    output.error('Could not save private rehearsal timing report; inspect ~/.imajin permissions privately.');
    return 1;
  }
}
/**
 * Dependencies are injectable only in-process for sandboxed fixtures. The CLI
 * has no mock mode, env override, arbitrary command, record path, or force flag.
 */
export async function main(argv, dependencies = {}) {
  const output = dependencies.output ?? console;
  let lock;
  let report;
  let decision;
  let result = 1;
  try {
    const { target, action, postCutover } = invocation(argv);
    const context = createContext(target, dependencies);
    if (action === 'rehearse') report = createReport(context.directory);
    context.report = report;
    lock = acquireLock(context);
    await execute(context, action, {
      run: timedCommand(dependencies.command ?? command, report, output), readTracking: dependencies.tracking ?? tracking,
      output, sleep: dependencies.sleep,
    }, postCutover);
    result = 0;
  } catch (error) {
    if (error instanceof Refusal) decision = error.decision;
    output.error(error instanceof Refusal ? error.message : 'Rollback failed: private configuration, process, or database error. No subprocess output or credentials are printed.');
  } finally {
    result = persistReport(report, result, decision, output);
    releaseLock(lock, output);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
