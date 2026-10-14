import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describe('deploy environment guard', () => {
  it.each(['dev', 'prod'])('accepts the %s first-boot contract', (target) => {
    expect(validateEnvironment(validEnv(target), target, () => false)).toEqual([]);
  });

  it('allows a restart without a claim code when a keystore exists', () => {
    const env = validEnv();
    delete env.IMAJIN_APP_CLAIM_CODE;
    expect(validateEnvironment(env, 'dev', () => true)).toEqual([]);
    expect(validateEnvironment(env, 'dev', () => false)).toContain('IMAJIN_APP_CLAIM_CODE: required on first boot (no keystore)');
  });

  it('reports missing fields and invalid target', () => {
    expect(validateEnvironment({}, 'other')).toEqual(['target must be dev or prod']);
    expect(validateEnvironment({}, 'dev', () => false).join('\n')).toContain('DATABASE_URL: required');
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
    ['WEBHOOK_SECRET', 'short'], ['ENABLE_TICKET_MIGRATION', 'true'],
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
