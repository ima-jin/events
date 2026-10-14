import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkFile, ENV_NAMES, validateEnvironment } from '../check-env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const require = createRequire(import.meta.url);

function validEnv(target = 'dev'): Record<string, string> {
  const host = target === 'dev' ? 'dev-jin.imajin.ai' : 'jin.imajin.ai';
  const base = `https://${host}`;
  return {
    DATABASE_URL: 'postgres://fixture/fixture',
    APP_DB_SCHEMA: 'events',
    IMAJIN_KERNEL_URL: base,
    IMAJIN_AUTH_URL: base,
    AUTH_SERVICE_URL: `${base}/auth`,
    NEXT_PUBLIC_IMAJIN_AUTH_URL: base,
    NEXT_PUBLIC_AUTH_URL: `${base}/auth`,
    NEXT_PUBLIC_APP_URL: `${base}/events`,
    NEXT_PUBLIC_EVENTS_URL: `${base}/events`,
    NEXT_PUBLIC_BASE_PATH: '/events',
    NEXT_PUBLIC_SERVICE_PREFIX: target === 'dev' ? 'dev-' : '',
    IMAJIN_ENV: target === 'dev' ? 'dev' : '',
    IMAJIN_APP_DID: 'did:imajin:fixture',
    IMAJIN_APP_KEYSTORE: `/fixture/events.${target}.keystore.json`,
    IMAJIN_APP_CLAIM_CODE: 'fixture-code',
    SESSION_SECRET: 's'.repeat(64),
    TICKET_QR_SECRET: 'q'.repeat(64),
    WEBHOOK_SECRET: 'w'.repeat(64),
  };
}

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === '__tests__') continue;
    if (entry.isDirectory()) result.push(...sourceFiles(path));
    if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      result.push(path);
    }
  }
  return result;
}

describe('blank-valued env contract', () => {
  it.each(['.env.example', '.env.dev.example', '.env.prod.example'])('%s contains no values', (file) => {
    for (const value of Object.values(parseEnv(read(file)))) expect(value).toBe('');
  });

  it('documents direct app/SDK reads and dynamic service overrides', () => {
    const paths = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'app'))];
    for (const name of readdirSync(join(root, 'node_modules/@ima-jin'))) {
      paths.push(...sourceFiles(realpathSync(join(root, 'node_modules/@ima-jin', name))));
    }
    paths.push(join(root, 'instrumentation.ts'), join(root, 'next.config.js'));
    const names = new Set<string>();
    for (const path of paths) {
      const content = readFileSync(path, 'utf8');
      for (const match of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
    }
    for (const service of ['AUTH', 'PAY', 'CONNECTIONS', 'PROFILE', 'CHAT', 'NOTIFY']) names.add(`${service}_SERVICE_URL`);
    for (const name of names) expect(ENV_NAMES, name).toContain(name);
    const docs = read('docs/ENVIRONMENTS.md');
    for (const name of ENV_NAMES) expect(docs, name).toContain(`\`${name}\``);
    const deployedNames = ENV_NAMES.filter((name: string) =>
      !['PORT', 'NODE_ENV', 'NEXT_RUNTIME', 'IMAJIN_APP_PRIVATE_KEY'].includes(name));
    for (const file of ['.env.dev.example', '.env.prod.example']) {
      expect(Object.keys(parseEnv(read(file))).sort()).toEqual([...deployedNames].sort());
    }
  });
});

describe('deploy workflow with sandboxed command fixtures', () => {
  function deploymentFixture() {
    const home = mkdtempSync(join(tmpdir(), 'events-deploy-'));
    const checkout = join(home, 'dev/events');
    const bin = join(home, 'bin');
    const calls = join(home, 'calls');
    for (const dir of [bin, join(checkout, 'scripts'), join(checkout, 'node_modules/next/dist/bin'),
      join(checkout, 'node_modules/drizzle-kit')]) mkdirSync(dir, { recursive: true });
    for (const file of ['scripts/deploy.sh', 'scripts/check-env.mjs', '.env.example']) {
      writeFileSync(join(checkout, file), read(file));
    }
    const env = validEnv();
    writeFileSync(join(checkout, '.env.local'), Object.entries(env).map(([key, value]) =>
      `${key}=${value}`).join('\n'), { mode: 0o600 });
    const recordNode = (name: string) => `
      const fs = process.getBuiltinModule("node:fs");
      if (process.env.IMAJIN_KERNEL_URL !== "https://dev-jin.imajin.ai") process.exit(3);
      fs.appendFileSync(process.env.FIXTURE_CALLS, "${name}\\n");
      if (process.env.FIXTURE_FAIL === "${name}") process.exit(4);
    `;
    writeFileSync(join(checkout, 'node_modules/next/dist/bin/next'), recordNode('build'));
    writeFileSync(join(checkout, 'scripts/migrate-baseline.mjs'), recordNode('baseline'));
    writeFileSync(join(checkout, 'node_modules/drizzle-kit/bin.cjs'), recordNode('migrate'));
    const tool = (name: string, body: string) => writeFileSync(join(bin, name),
      `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    tool('git', '[[ "$1" == status ]] || printf "git %s\\n" "$1" >> "$FIXTURE_CALLS"');
    tool('pnpm', 'printf "install\\n" >> "$FIXTURE_CALLS"');
    tool('pm2', `if [[ "$1" == jlist ]]; then
      printf '%s' "\${FIXTURE_PM2:-[]}"
    else
      [[ -z "\${IMAJIN_APP_CLAIM_CODE:-}" && -z "\${DATABASE_URL:-}" ]] || exit 5
      printf "pm2 %s\\n" "$1" >> "$FIXTURE_CALLS"
    fi`);
    tool('curl', `printf '%s' '{"status":"ok","service":"imajin-events"}'`);
    return {
      home, calls,
      run: (overrides: Record<string, string> = {}) => spawnSync('bash',
        [join(checkout, 'scripts/deploy.sh'), 'dev'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
            FIXTURE_CALLS: calls, DATABASE_URL: 'inherited-fixture-must-not-win',
            IMAJIN_KERNEL_URL: 'inherited-fixture-must-not-win', IMAJIN_APP_CLAIM_CODE: 'inherited-fixture',
            ...overrides },
        }),
    };
  }

  it('runs install/build/baseline/migrate before pm2 start/save with file-authoritative env', () => {
    const fixture = deploymentFixture();
    try {
      const result = fixture.run();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(readFileSync(fixture.calls, 'utf8').trim().split('\n')).toEqual([
        'git fetch', 'git checkout', 'install', 'build', 'baseline', 'migrate', 'pm2 start', 'pm2 save',
      ]);
      expect(result.stdout).not.toContain('inherited-fixture');
      expect(result.stdout).not.toContain('fixture-code');
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it.each(['build', 'baseline', 'migrate'])('does not touch pm2 if %s fails', (step) => {
    const fixture = deploymentFixture();
    try {
      expect(fixture.run({ FIXTURE_FAIL: step }).status).toBe(4);
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain('pm2');
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it.each(['invalid-json', '[{"name":"dev-events","pm2_env":{"pm_cwd":"/old/kernel"}}]'])(
    'refuses invalid/stale pm2 before fetch or install', (processes) => {
      const fixture = deploymentFixture();
      try {
        expect(fixture.run({ FIXTURE_PM2: processes }).status).toBe(1);
        expect(() => readFileSync(fixture.calls)).toThrow();
      } finally {
        rmSync(fixture.home, { recursive: true, force: true });
      }
    },
  );
});

describe('deploy environment guard', () => {
  it.each(['dev', 'prod'])('accepts the %s first-boot contract', (target) => {
    expect(validateEnvironment(validEnv(target), target, () => false)).toEqual([]);
  });

  it('allows a restart without a claim code when a keystore exists', () => {
    const env = validEnv();
    delete env.IMAJIN_APP_CLAIM_CODE;
    expect(validateEnvironment(env, 'dev', () => true)).toEqual([]);
  });

  it.each(['dev', 'prod'])('only warns on %s first boot with no keystore or claim code', (target) => {
    const env = validEnv(target);
    delete env.IMAJIN_APP_CLAIM_CODE;
    const warnings: string[] = [];
    expect(validateEnvironment(env, target, () => false, warnings)).toEqual([]);
    expect(warnings.join('\n')).toContain('No keystore found and IMAJIN_APP_CLAIM_CODE is not set');
    expect(warnings.join('\n')).toContain('claim at /events/claim after boot');

    const withCode: string[] = [];
    expect(validateEnvironment(validEnv(target), target, () => false, withCode)).toEqual([]);
    expect(withCode).toEqual([]);
    const withKeystore: string[] = [];
    expect(validateEnvironment(env, target, () => true, withKeystore)).toEqual([]);
    expect(withKeystore).toEqual([]);
  });

  it('exits 0 and warns on an unclaimed first boot without echoing values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-unclaimed-env-'));
    const file = join(dir, '.env.local');
    const env = validEnv();
    delete env.IMAJIN_APP_CLAIM_CODE;
    env.IMAJIN_APP_KEYSTORE = join(dir, 'events.dev.keystore.json');
    try {
      writeFileSync(file, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
      const result = spawnSync(process.execPath, [join(root, 'scripts/check-env.mjs'), 'dev', file], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/^warning: No keystore found and IMAJIN_APP_CLAIM_CODE is not set/m);
      expect(result.stderr).toContain('claim at /events/claim after boot');
      expect(result.stderr).not.toMatch(/^error:/m);
      expect(result.stdout).toContain('Environment validated');
      for (const secret of [env.SESSION_SECRET, env.WEBHOOK_SECRET, env.DATABASE_URL]) {
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing fields and invalid target', () => {
    expect(validateEnvironment({}, 'other')).toEqual(['target must be dev or prod']);
    expect(validateEnvironment({}, 'dev', () => false).join('\n')).toContain('DATABASE_URL: required');
  });

  it('requires the app-held ticket QR secret without exposing values', () => {
    const env = validEnv();
    delete env.TICKET_QR_SECRET;
    expect(validateEnvironment(env, 'dev', () => true)).toContain('TICKET_QR_SECRET: required');
  });

  it.each(['IMAJIN_APP_PRIVATE_KEY', 'AUTH_INTERNAL_API_KEY', 'PROFILE_INTERNAL_API_KEY',
    'ENABLE_REQUEST_LOG', 'ENABLE_APP_LOG', 'LOG_DB_TRANSPORT', 'PORT', 'NODE_ENV', 'NEXT_RUNTIME'])(
    'refuses %s without leaking its value', (name) => {
      const problems = validateEnvironment({ ...validEnv(), [name]: 'never-print-fixture' }, 'dev');
      expect(problems).toContain(`${name}: must be unset`);
      expect(problems.join('\n')).not.toContain('never-print-fixture');
    },
  );

  it.each(['https://jin.imajin.ai', 'http://dev-jin.imajin.ai', 'https://dev-jin.imajin.ai/wrong',
    'https://user:fixture@dev-jin.imajin.ai', 'invalid-fixture'])('refuses wrong URL shape %s', (url) => {
    const problems = validateEnvironment({ ...validEnv(), IMAJIN_KERNEL_URL: url }, 'dev');
    expect(problems.join('\n')).toMatch(/IMAJIN_KERNEL_URL: (wrong|invalid)/);
    expect(problems.join('\n')).not.toContain(url);
  });

  it.each([
    ['APP_DB_SCHEMA', 'other'], ['NEXT_PUBLIC_BASE_PATH', ''],
    ['NEXT_PUBLIC_DOMAIN', 'other'], ['NEXT_PUBLIC_SERVICE_PREFIX', ''],
    ['IMAJIN_ENV', ''], ['IMAJIN_APP_DID', 'invalid'],
    ['IMAJIN_APP_AUD', 'jin.imajin.ai'], ['SESSION_SECRET', 'short'],
    ['TICKET_QR_SECRET', 'short'], ['WEBHOOK_SECRET', 'short'], ['ENABLE_TICKET_MIGRATION', 'true'],
    ['IMAJIN_APP_KEYSTORE', './relative.json'],
  ])('refuses %s drift', (name, value) => {
    expect(validateEnvironment({ ...validEnv(), [name]: value }, 'dev', () => true).join('\n')).toContain(name);
  });

  it('validates private env/keystore permissions and CLI exit codes without values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-env-'));
    const file = join(dir, '.env.local');
    const keystore = join(dir, 'events.dev.keystore.json');
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/check-env.mjs'), ...args], { encoding: 'utf8' });
    try {
      // Deliberately no key material: checker only reads file metadata.
      writeFileSync(keystore, '{}', { mode: 0o600 });
      const env: Record<string, string> = { ...validEnv(), IMAJIN_APP_KEYSTORE: keystore };
      writeFileSync(file, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
      expect(checkFile('dev', file)).toEqual([]);
      expect(cli('dev', file).status).toBe(0);
      chmodSync(file, 0o644);
      chmodSync(keystore, 0o644);
      expect(checkFile('dev', file)).toHaveLength(2);
      const rejected = cli('dev', file);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout + rejected.stderr).not.toContain(env.IMAJIN_APP_CLAIM_CODE);
      expect(cli('dev', file, 'extra').status).toBe(2);
      expect(cli('dev', join(dir, 'missing')).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('standalone pm2 and deploy contract', () => {
  it('uses canonical standalone paths and original listener ports', () => {
    const { apps } = require('../../ecosystem.config.cjs');
    expect(apps.map((app: { name: string }) => app.name)).toEqual(['dev-events', 'prod-events']);
    for (const [index, target] of ['dev', 'prod'].entries()) {
      const app = apps[index];
      expect(app.cwd).toBe(join(homedir(), target, 'events'));
      expect(app.script).toBe('node_modules/next/dist/bin/next');
      expect(app.args).toBe(`start -p ${target === 'dev' ? 3006 : 7006}`);
      expect(app.node_args).toBe(`--env-file=${join(app.cwd, '.env.local')}`);
      expect(app.env.NODE_ENV).toBe('production');
      expect(app.cwd).not.toContain('imajin-ai/apps');
    }
  });

  it('has valid shell syntax and fails bad invocation before external actions', () => {
    const file = join(root, 'scripts/deploy.sh');
    expect(spawnSync('bash', ['-n', file]).status).toBe(0);
    expect(spawnSync('bash', [file, 'invalid']).status).toBe(1);
    expect(spawnSync('bash', [file, 'dev']).status).toBe(1); // sandbox is not the host checkout
    const script = read('scripts/deploy.sh');
    expect(script.indexOf('scripts/migrate-baseline.mjs')).toBeLessThan(script.indexOf('pm2 restart ecosystem'));
    expect(script).toContain('pm2 save');
    expect(script).not.toContain('set -x');
  });
});
