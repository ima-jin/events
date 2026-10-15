import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkMigrations, command, main, tracking } from '../soak/rollback.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ref = 'a'.repeat(40);
const baseline = 'b'.repeat(64);
const unknown = 'c'.repeat(64);
const privateMarker = 'PRIVATE_FIXTURE_NOT_A_CREDENTIAL';

function fixture(target = 'dev') {
  const home = mkdtempSync(join(tmpdir(), 'events-rollback-'));
  const checkout = join(home, target, 'events');
  const kernel = join(home, target, 'imajin-ai/apps/events');
  const kernelMigrations = join(home, target, 'imajin-ai/migrations');
  for (const directory of [checkout, kernelMigrations, join(kernel, '.next'),
    join(kernel, 'node_modules/next/dist/bin'), join(checkout, 'migrations')]) {
    mkdirSync(directory, { recursive: true });
  }
  const envFile = join(checkout, '.env.local');
  writeFileSync(envFile, [
    `DATABASE_URL=postgres://fixture/${privateMarker}`,
    'APP_DB_SCHEMA=events', 'NEXT_PUBLIC_EVENTS_URL=https://fixture.example/events',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(kernel, '.env.local'), `UNUSED_FIXTURE=${privateMarker}`, { mode: 0o600 });
  writeFileSync(join(kernel, '.next/BUILD_ID'), 'fixture-build');
  writeFileSync(join(kernel, 'node_modules/next/dist/bin/next'), 'fixture-executable');
  writeFileSync(join(checkout, 'ecosystem.config.cjs'), '// fixture');
  const sql = 'fixture known migration, not executable SQL';
  writeFileSync(join(kernelMigrations, '0001_fixture.sql'), sql);
  writeFileSync(join(checkout, 'migrations/0001_fixture.sql'), sql);
  const known = createHash('sha256').update(sql).digest('hex');
  let hashes = [baseline];
  let cwd: string | undefined = kernel;
  let fail = '';
  let persistentFailure = false;
  let pm2Output: string | undefined;
  let failHealth = false;
  const calls: { tool: string; args: string[] }[] = [];
  const logs: string[] = [];
  const name = `${target}-events`;
  const pm2 = () => cwd ? [{
    name,
    pm2_env: {
      pm_cwd: cwd, pm_exec_path: join(cwd, 'node_modules/next/dist/bin/next'),
      args: ['start', '-p', target === 'dev' ? '3006' : '7006'],
      node_args: [`--env-file=${join(cwd, '.env.local')}`],
      DATABASE_URL: privateMarker, env: { SIGNING_KEY: privateMarker },
      arbitrary: privateMarker,
    },
  }, { name: 'unrelated-app', pm2_env: { PRIVATE: privateMarker } }] : [];
  const pm2Command = (args: string[]) => {
    if (args[0] === 'jlist') return pm2Output ?? JSON.stringify(pm2());
    if (args[0] === 'delete') cwd = undefined;
    if (args[0] === 'start') cwd = kernel;
    return '';
  };
  const run = async (action: string, ...flags: string[]) => main([target, action, ...flags], {
    home, root: checkout, output: { log: (line: string) => logs.push(line), error: (line: string) => logs.push(line) },
    tracking: async () => hashes,
    sleep: async () => {},
    command: (tool: string, args: string[]) => {
      calls.push({ tool, args });
      if (`${tool} ${args[0]}` === fail) {
        if (!persistentFailure) fail = '';
        throw new Error(privateMarker);
      }
      if (tool === 'git' && args[0] === 'rev-parse') return ref;
      if (tool === 'pm2') return pm2Command(args);
      if (tool === 'curl') {
        if (failHealth && cwd === kernel) throw new Error(privateMarker);
        return '{"status":"ok","service":"imajin-events"}';
      }
      if (tool === 'bash' && args[0] === 'scripts/deploy.sh') cwd = checkout;
      return '';
    },
  });
  const recordFiles = () => existsSync(join(home, '.imajin'))
    ? readdirSync(join(home, '.imajin')).filter((file) => file.startsWith('events-rollback-') && file.endsWith('.json'))
    : [];
  const reportFiles = () => existsSync(join(home, '.imajin'))
    ? readdirSync(join(home, '.imajin')).filter((file) => file.startsWith('events-rehearsal-') && file.endsWith('.json'))
    : [];
  return {
    home, checkout, kernel, known, calls, logs, run, recordFiles, reportFiles, processes: pm2,
    record: () => readFileSync(join(home, '.imajin', recordFiles()[0]), 'utf8'),
    report: () => readFileSync(join(home, '.imajin', reportFiles()[0]), 'utf8'),
    setHashes: (value: string[]) => { hashes = value; },
    setCwd: (value: string | undefined) => { cwd = value; },
    setFail: (value: string) => { fail = value; },
    setPersistentFailure: () => { persistentFailure = true; },
    setPm2Output: (value: string) => { pm2Output = value; },
    setHealthFailure: () => { failHealth = true; },
    getCwd: () => cwd,
    clear: () => { calls.length = 0; logs.length = 0; },
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

const mutations = (calls: { tool: string; args: string[] }[]) => calls
  .filter((call) => (call.tool === 'pm2' && call.args[0] !== 'jlist') ||
    (call.tool === 'bash' && call.args[0] === 'scripts/deploy.sh'))
  .map((call) => `${call.tool} ${call.args.join(' ')}`);

describe('rollback operator contract with sandboxed process fixtures', () => {
  it('has valid shell/module syntax and refuses invalid CLI/prod rehearsal before external work', () => {
    expect(spawnSync('bash', ['-n', join(root, 'scripts/soak/rollback.sh')]).status).toBe(0);
    expect(spawnSync(process.execPath, ['--check', join(root, 'scripts/soak/rollback.mjs')]).status).toBe(0);
    for (const args of [['invalid', 'record'], ['prod', 'rehearse'], ['dev', 'rollback', '--force']]) {
      const result = spawnSync('bash', [join(root, 'scripts/soak/rollback.sh'), ...args], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(privateMarker);
    }
  });

  it('refuses rollback without a pre-cutover record before any process inspection or mutation', async () => {
    const f = fixture();
    try {
      expect(await f.run('rollback')).toBe(1);
      expect(f.logs.join('\n')).toContain('No pre-cutover rollback record');
      expect(f.calls).toEqual([]);
    } finally { f.dispose(); }
  });

  it('records current kernel events with only allowlisted fields and private timestamp JSON', async () => {
    const f = fixture();
    try {
      f.setHashes([f.known]);
      expect(await f.run('record')).toBe(0);
      const text = f.record();
      const record = JSON.parse(text);
      expect(f.recordFiles()[0]).toMatch(/^events-rollback-dev-[0-9T_Z-]+\.json$/);
      expect(statSync(join(f.home, '.imajin', f.recordFiles()[0])).mode & 0o777).toBe(0o600);
      expect(statSync(join(f.home, '.imajin')).mode & 0o777).toBe(0o700);
      expect(Object.keys(record.process)).toEqual(['name', 'cwd', 'exec', 'args', 'node_args', 'envFile', 'port']);
      expect(record.process.cwd).toBe(f.kernel);
      expect(record.process.envFile).toBe(join(f.kernel, '.env.local'));
      expect(record.standaloneRef).toBe(ref);
      expect(record.source).toBe('observed');
      expect(record.migrations).toEqual([{ hash: f.known, name: '0001_fixture' }]);
      expect(text + f.logs.join('\n')).not.toContain(privateMarker);
      expect(text).not.toContain('DATABASE_URL');
      expect(text).not.toContain('unrelated-app');
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it('never records standalone as a kernel rollback target, including a post-cutover rehearsal without prior record', async () => {
    const f = fixture();
    try {
      f.setCwd(f.checkout);
      expect(await f.run('record')).toBe(1);
      expect(await f.run('rehearse')).toBe(1);
      expect(f.recordFiles()).toEqual([]);
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it.each(['args', 'node_args'])('rejects unapproved %s without writing their values', async (field) => {
    const f = fixture();
    try {
      f.setPm2Output(JSON.stringify([{
        name: 'dev-events', pm2_env: {
          pm_cwd: f.kernel, pm_exec_path: join(f.kernel, 'node_modules/next/dist/bin/next'),
          args: ['start', '-p', '3006'], node_args: [],
          [field]: [privateMarker],
        },
      }]));
      expect(await f.run('record')).toBe(1);
      expect(f.recordFiles()).toEqual([]);
      expect(f.logs.join('\n')).not.toContain(privateMarker);
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it.each(['rollback', 'rehearse'])('refuses %s after an unknown migration; prints only its safe hash', async (action) => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      f.clear();
      f.setCwd(f.checkout);
      f.setHashes([baseline, unknown]);
      expect(await f.run(action)).toBe(1);
      expect(f.logs.join('\n')).toContain(unknown);
      expect(f.logs.join('\n')).toContain('no force bypass');
      expect(f.logs.join('\n')).not.toContain(privateMarker);
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it('refuses a missing kernel build with precise #2804 prerequisite before touching PM2', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      rmSync(join(f.kernel, '.next/BUILD_ID'));
      f.clear();
      expect(await f.run('rollback')).toBe(1);
      expect(f.logs.join('\n')).toContain('.next/BUILD_ID missing (#2804)');
      expect(f.logs.join('\n')).toContain('pnpm --filter @imajin/events build');
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it('restores saved definition then saves before loopback/public health from the env URL', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      f.setCwd(f.checkout);
      f.setHashes([baseline, f.known]);
      f.clear();
      expect(await f.run('rollback')).toBe(0);
      const commands = mutations(f.calls);
      expect(commands).toEqual([
        'pm2 delete dev-events',
        `pm2 start ${f.kernel}/node_modules/next/dist/bin/next --name dev-events --cwd ${f.kernel} --interpreter node --node-args --env-file=${f.kernel}/.env.local -- start -p 3006`,
        'pm2 save',
      ]);
      const healthCalls = f.calls.filter((call) => call.tool === 'curl');
      expect(healthCalls.map((call) => call.args.at(-1))).toEqual([
        'http://127.0.0.1:3006/events/api/health', 'https://fixture.example/events/api/health',
      ]);
      expect(f.calls.indexOf(healthCalls[0])).toBeGreaterThan(f.calls.findIndex((call) => call.args[0] === 'save'));
      expect(f.logs.join('\n')).toContain('elapsed');
      expect(f.logs.join('\n')).toContain('new standalone app identity may fail');
      expect(f.logs.join('\n')).toContain('standalone NEW QR secret will not verify on the kernel copy');
      expect(f.logs.join('\n')).toContain('pre-cutover ticket QRs may verify again');
      expect(f.logs.join('\n')).toContain('paid flows fail closed');
      expect(f.getCwd()).toBe(f.kernel);
    } finally { f.dispose(); }
  });

  it.each([false, true])('rehearses to standalone using the pinned ref and preserves a prior record: %s', async (afterCutover) => {
    const f = fixture();
    try {
      let original: string | undefined;
      if (afterCutover) {
        expect(await f.run('record')).toBe(0);
        original = f.record();
        f.setCwd(f.checkout);
        f.clear();
      }
      expect(await f.run('rehearse')).toBe(0);
      if (original) expect(f.record()).toBe(original);
      expect(f.recordFiles()).toHaveLength(1);
      expect(f.getCwd()).toBe(f.checkout);
      expect(mutations(f.calls).map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
        'pm2 delete', 'pm2 start', 'pm2 save', 'pm2 delete', 'pm2 save', 'bash scripts/deploy.sh',
      ]);
      expect(f.calls.find((call) => call.args[0] === 'scripts/deploy.sh')?.args).toEqual([
        'scripts/deploy.sh', 'dev', ref,
      ]);
      const firstDelete = f.calls.findIndex((call) => call.args[0] === 'delete');
      const envCheck = f.calls.findIndex((call) => call.tool === 'node');
      expect(envCheck).toBeLessThan(firstDelete);
      expect(f.logs.join('\n')).toContain('Rehearsal complete; standalone events restored');
    } finally { f.dispose(); }
  });

  it('writes a private safe rehearsal report with individually timed transition commands', async () => {
    const f = fixture();
    try {
      expect(await f.run('rehearse')).toBe(0);
      expect(f.reportFiles()).toHaveLength(1);
      const file = f.reportFiles()[0];
      expect(file).toMatch(/^events-rehearsal-dev-[0-9T_Z-]+\.json$/);
      expect(statSync(join(f.home, '.imajin', file)).mode & 0o777).toBe(0o600);
      const text = f.report();
      const report = JSON.parse(text);
      expect(report.status).toBe('pass');
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.steps.map((step: { label: string }) => step.label)).toEqual(expect.arrayContaining([
        'rollback preflight', 'Remove current events', 'Start saved kernel events definition',
        'Persist events rollback', 'Remove events for roll-forward', 'Persist roll-forward boundary',
        'Recorded standalone deployment', 'loopback health', 'public health',
      ]));
      for (const step of report.steps) {
        expect(Object.keys(step)).toEqual(['label', 'status', 'durationMs']);
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
        expect(step.status).toBe('pass');
      }
      for (const forbidden of [privateMarker, f.home, ref, 'DATABASE_URL', '.env.local', 'node_modules']) {
        expect(text).not.toContain(forbidden);
      }
    } finally { f.dispose(); }
  });

  it('writes a failed #2804 DECISION report before querying removed kernel migrations', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      rmSync(join(f.kernel, '.next'), { recursive: true });
      rmSync(join(f.home, 'dev/imajin-ai/migrations'), { recursive: true });
      f.clear();
      expect(await f.run('rehearse')).toBe(1);
      expect(f.logs.join('\n')).toContain('DECISION #2804');
      expect(mutations(f.calls)).toEqual([]);
      const report = JSON.parse(f.report());
      expect(report.status).toBe('fail');
      expect(report.decision).toEqual({
        code: '#2804', status: 'operator-decision-required', prerequisite: 'approved-kernel-events-build',
      });
      expect(report.steps).toContainEqual(expect.objectContaining({ label: 'rollback preflight', status: 'fail' }));
      expect(f.report()).not.toContain(privateMarker);
    } finally { f.dispose(); }
  });

  it.each(['pm2 start', 'health'])('recovers standalone after rehearsal %s failure while returning failure', async (stage) => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      f.setCwd(f.checkout);
      if (stage === 'health') f.setHealthFailure();
      else f.setFail(stage);
      f.clear();
      expect(await f.run('rehearse')).toBe(1);
      expect(f.getCwd()).toBe(f.checkout);
      expect(f.logs.join('\n')).toContain('Recorded standalone recovery succeeded');
      expect(f.logs.join('\n')).not.toContain(privateMarker);
      expect(JSON.parse(f.report()).status).toBe('fail');
    } finally { f.dispose(); }
  });

  it('does not delete events when roll-forward env preflight fails', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      f.clear();
      f.setFail('node scripts/check-env.mjs');
      expect(await f.run('rehearse')).toBe(1);
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it('can restore saved kernel events after an interrupted operation left no events process', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      f.setCwd(undefined);
      f.clear();
      expect(await f.run('rollback')).toBe(0);
      expect(f.getCwd()).toBe(f.kernel);
      expect(mutations(f.calls).some((call) => call.startsWith('pm2 delete'))).toBe(false);
    } finally { f.dispose(); }
  });

  it('refuses missing health tooling before deleting events', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      f.clear();
      f.setFail('bash -c');
      expect(await f.run('rollback')).toBe(1);
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it('reports failed recovery safely and preserves the prior record for operator reconciliation', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      const original = f.record();
      f.clear();
      f.setFail('bash scripts/deploy.sh');
      f.setPersistentFailure();
      expect(await f.run('rehearse')).toBe(1);
      expect(f.logs.join('\n')).toContain('Standalone recovery failed. Stop cutover');
      expect(f.logs.join('\n')).not.toContain(privateMarker);
      expect(f.record()).toBe(original);
      for (const call of f.calls.filter((entry) => entry.tool === 'pm2' && entry.args[0] === 'delete')) {
        expect(call.args).toEqual(['delete', 'dev-events']);
      }
    } finally { f.dispose(); }
  });

  it('rejects unsafe record permissions instead of replaying them', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      chmodSync(join(f.home, '.imajin', f.recordFiles()[0]), 0o644);
      f.clear();
      expect(await f.run('rollback')).toBe(1);
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });
});

describe('explicit dev post-cutover recording', () => {
  it('synthesizes only the canonical kernel destination and rehearses back to standalone', async () => {
    const f = fixture();
    try {
      f.setCwd(f.checkout);
      f.setHashes([f.known, baseline]);
      expect(await f.run('record', '--post-cutover')).toBe(0);
      const original = f.record();
      const record = JSON.parse(original);
      expect(record.source).toBe('post-cutover-synthesized');
      expect(record.process).toEqual({
        name: 'dev-events', cwd: f.kernel, exec: join(f.kernel, 'node_modules/next/dist/bin/next'),
        args: ['start', '-p', '3006'], node_args: [`--env-file=${join(f.kernel, '.env.local')}`],
        envFile: join(f.kernel, '.env.local'), port: 3006,
      });
      expect(record.standaloneRef).toBe(ref);
      expect(record.migrations).toEqual([{ hash: f.known, name: '0001_fixture' }, { hash: baseline, name: null }]);
      expect(statSync(join(f.home, '.imajin', f.recordFiles()[0])).mode & 0o777).toBe(0o600);
      expect(mutations(f.calls)).toEqual([]);
      f.clear();
      expect(await f.run('rehearse')).toBe(0);
      expect(f.record()).toBe(original);
      expect(f.getCwd()).toBe(f.checkout);
      expect(mutations(f.calls)).toEqual([
        'pm2 delete dev-events',
        `pm2 start ${f.kernel}/node_modules/next/dist/bin/next --name dev-events --cwd ${f.kernel} --interpreter node --node-args --env-file=${f.kernel}/.env.local -- start -p 3006`,
        'pm2 save', 'pm2 delete dev-events', 'pm2 save', `bash scripts/deploy.sh dev ${ref}`,
      ]);
      expect(f.calls.filter((call) => call.tool === 'curl').map((call) => call.args.at(-1))).toEqual([
        'http://127.0.0.1:3006/events/api/health', 'https://fixture.example/events/api/health',
        'http://127.0.0.1:3006/events/api/health', 'https://fixture.example/events/api/health',
      ]);
      expect(JSON.parse(f.report())).toMatchObject({ source: 'post-cutover-synthesized', status: 'pass' });
      expect(original + f.report() + f.logs.join('\n')).not.toContain(privateMarker);
      for (const forbidden of [f.home, '.env.local', ref]) expect(f.report()).not.toContain(forbidden);
    } finally { f.dispose(); }
  });

  it('refuses synthesized recording for prod before inspection and keeps normal prod observed-only', async () => {
    const f = fixture('prod');
    try {
      f.setCwd(f.checkout);
      expect(await f.run('record', '--post-cutover')).toBe(1);
      expect(f.logs.join('\n')).toContain('prod must record before cutover');
      expect(f.calls).toEqual([]);
      expect(await f.run('record')).toBe(1);
      expect(f.recordFiles()).toEqual([]);
      f.setCwd(f.kernel);
      expect(await f.run('record')).toBe(0);
      expect(JSON.parse(f.record()).source).toBe('observed');
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it.each(['unknown', 'duplicated', 'kernel', 'absent', 'wrong-exec', 'wrong-args', 'missing-node-args', 'wrong-node-args'])(
    'refuses post-cutover recording when current events is %s', async (state) => {
      const f = fixture();
      try {
        f.setCwd(f.checkout);
        const processes = f.processes();
        const pm = processes[0].pm2_env;
        if (state === 'unknown') pm.pm_cwd = join(f.home, 'unknown');
        if (state === 'duplicated') processes.push(processes[0]);
        if (state === 'kernel') f.setCwd(f.kernel);
        if (state === 'absent') f.setCwd(undefined);
        if (state === 'wrong-exec') pm.pm_exec_path = '/unapproved/executable';
        if (state === 'wrong-args') pm.args = ['start', '-p', '7006'];
        if (state === 'missing-node-args') pm.node_args = [];
        if (state === 'wrong-node-args') pm.node_args = [`--env-file=${join(f.kernel, '.env.local')}`];
        if (!['kernel', 'absent'].includes(state)) f.setPm2Output(JSON.stringify(processes));
        expect(await f.run('record', '--post-cutover')).toBe(1);
        expect(f.recordFiles()).toEqual([]);
        expect(mutations(f.calls)).toEqual([]);
        expect(f.logs.join('\n')).not.toContain(privateMarker);
      } finally { f.dispose(); }
    },
  );

  it.each(['build', 'executable', 'env-missing', 'env-readable', 'env-symlink', 'env-directory'])(
    'refuses a missing or unsafe kernel prerequisite: %s', async (prerequisite) => {
      const f = fixture();
      try {
        f.setCwd(f.checkout);
        const envFile = join(f.kernel, '.env.local');
        if (prerequisite === 'build') rmSync(join(f.kernel, '.next/BUILD_ID'));
        if (prerequisite === 'executable') rmSync(join(f.kernel, 'node_modules/next/dist/bin/next'));
        if (prerequisite === 'env-missing') rmSync(envFile);
        if (prerequisite === 'env-readable') chmodSync(envFile, 0o640);
        if (prerequisite === 'env-symlink') {
          rmSync(envFile);
          symlinkSync(join(f.checkout, '.env.local'), envFile);
        }
        if (prerequisite === 'env-directory') {
          rmSync(envFile);
          mkdirSync(envFile, { mode: 0o600 });
        }
        expect(await f.run('record', '--post-cutover')).toBe(1);
        expect(f.recordFiles()).toEqual([]);
        expect(mutations(f.calls)).toEqual([]);
        if (prerequisite === 'build') expect(f.logs.join('\n')).toContain('DECISION #2804');
        expect(f.logs.join('\n')).not.toContain(privateMarker);
      } finally { f.dispose(); }
    },
  );

  it.each(['rollback', 'rehearse'])('allows the post-cutover flag only with record, not %s', async (action) => {
    const f = fixture();
    try {
      expect(await f.run(action, '--post-cutover')).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.recordFiles()).toEqual([]);
    } finally { f.dispose(); }
  });

  it('retains migration refusal after the synthesized recording boundary', async () => {
    const f = fixture();
    try {
      f.setCwd(f.checkout);
      expect(await f.run('record', '--post-cutover')).toBe(0);
      f.setHashes([baseline, unknown]);
      f.clear();
      expect(await f.run('rehearse')).toBe(1);
      expect(mutations(f.calls)).toEqual([]);
      expect(JSON.parse(f.report())).toMatchObject({ source: 'post-cutover-synthesized', status: 'fail' });
      expect(f.logs.join('\n')).toContain('Post-record migrations unknown');
    } finally { f.dispose(); }
  });

  it.each(['invalid-source', 'noncanonical-destination', 'synthesized-prod'])('rejects tampered saved provenance: %s', async (state) => {
    const f = fixture(state === 'synthesized-prod' ? 'prod' : 'dev');
    try {
      expect(await f.run('record')).toBe(0);
      const record = JSON.parse(f.record());
      record.source = state === 'invalid-source' ? 'unapproved' : 'post-cutover-synthesized';
      if (state === 'noncanonical-destination') record.process.node_args = [];
      writeFileSync(join(f.home, '.imajin', f.recordFiles()[0]), JSON.stringify(record));
      f.clear();
      expect(await f.run('rollback')).toBe(1);
      expect(mutations(f.calls)).toEqual([]);
    } finally { f.dispose(); }
  });

  it('accepts legacy observed records without a source label and reports observed provenance', async () => {
    const f = fixture();
    try {
      expect(await f.run('record')).toBe(0);
      const record = JSON.parse(f.record());
      delete record.source;
      writeFileSync(join(f.home, '.imajin', f.recordFiles()[0]), JSON.stringify(record));
      expect(await f.run('rehearse')).toBe(0);
      expect(JSON.parse(f.report()).source).toBe('observed');
    } finally { f.dispose(); }
  });
});
describe('private subprocess and events-only migration readers', () => {
  it('suppresses raw subprocess stdout/stderr even on failures', () => {
    try {
      command(process.execPath, ['-e', `console.log("${privateMarker}"); console.error("${privateMarker}"); process.exit(1)`]);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(privateMarker);
      expect(String(error)).toContain('inspect locally');
    }
  });

  it('does not grandfather post-record unknown hashes or a shrunken history', () => {
    expect(() => checkMigrations({ migrations: [] }, [unknown], [])).toThrow(unknown);
    expect(() => checkMigrations({ migrations: [{ hash: baseline }] }, [], [])).toThrow('history shrank');
  });

  it('reads only events tracking hashes in a read-only transaction and closes the private connection', async () => {
    const queries: string[] = [];
    let closed = false;
    const tx = async (parts: TemplateStringsArray) => {
      const sql = parts.join('');
      queries.push(sql);
      return sql.includes('to_regclass') ? [{ present: true }] : [{ hash: baseline }];
    };
    const connect = (url: string) => {
      expect(url).toBe('postgres://fixture/private');
      return {
        begin: async (mode: string, callback: (sql: typeof tx) => Promise<unknown>) => {
          expect(mode).toBe('read only');
          return callback(tx);
        },
        end: async () => { closed = true; },
      };
    };
    const adapter = connect as unknown as Parameters<typeof tracking>[1];
    expect(await tracking({ DATABASE_URL: 'postgres://fixture/private', APP_DB_SCHEMA: 'events' }, adapter)).toEqual([baseline]);
    expect(queries).toEqual([
      "SELECT to_regclass('events.__drizzle_migrations') IS NOT NULL AS present",
      'SELECT hash FROM events.__drizzle_migrations ORDER BY id',
    ]);
    expect(closed).toBe(true);
  });
});
