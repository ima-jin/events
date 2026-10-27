import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkFile, ENV_NAMES, validateEnvironment } from '../check-env.mjs';
import { validEnv } from './support/deploy-env';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const require = createRequire(import.meta.url);


function sourceFiles(directory: string, extension = /\.(?:[cm]?js|tsx?)$/): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === '__tests__') continue;
    if (entry.isDirectory()) result.push(...sourceFiles(path, extension));
    if (entry.isFile() && extension.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      result.push(path);
    }
  }
  return result;
}

describe('blank-valued env contract', () => {
  it('keeps the platform Stripe key out of app source, env inventory and operator docs', () => {
    const name = 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY';
    expect(ENV_NAMES).not.toContain(name);
    const paths = [
      ...readdirSync(root).filter((file) => file.startsWith('.env') && file.endsWith('.example')),
      'README.md', 'instrumentation.ts', 'middleware.ts',
      ...sourceFiles(join(root, 'docs'), /\.md$/),
      ...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'app')),
    ];
    for (const path of paths) {
      const content = path.startsWith(root) ? readFileSync(path, 'utf8') : read(path);
      expect(content, path).not.toContain(name);
    }
  });
  it('has no shared webhook credential or manual generation instructions in operational surfaces', () => {
    const paths = [
      '.env.example', '.env.dev.example', '.env.prod.example', 'scripts/check-env.mjs',
      'README.md', 'api-spec/openapi.yaml',
      ...sourceFiles(join(root, 'docs'), /\.md$/).map((path) => path.slice(root.length)),
    ];
    for (const name of ['WEBHOOK_SECRET', 'NOTIFY_WEBHOOK_SECRET']) {
      expect(ENV_NAMES).not.toContain(name);
      for (const path of paths) expect(read(path), path).not.toContain(name);
    }
    for (const path of paths) expect(read(path), path).not.toContain('openssl rand');
  });
  it('removes IMAJIN_APP_CLAIM_CODE from supported configuration, runtime code and operator docs', () => {
    expect(ENV_NAMES).not.toContain('IMAJIN_APP_CLAIM_CODE');
    const paths = [
      '.env.example', '.env.dev.example', '.env.prod.example', 'README.md', 'AGENTS.md',
      'instrumentation.ts', 'middleware.ts', 'scripts/check-env.mjs', 'scripts/deploy.sh',
      ...readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
      ...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'app')),
    ];
    for (const path of paths) {
      const content = path.startsWith(root) ? readFileSync(path, 'utf8') : read(path);
      expect(content, path).not.toContain('IMAJIN_APP_CLAIM_CODE');
    }
  });
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
    // The SDK still reads a retired fallback internally; the app explicitly disables it.
    names.delete('IMAJIN_APP_CLAIM_CODE');
    for (const name of names) expect(ENV_NAMES, name).toContain(name);
    const docs = read('docs/ENVIRONMENTS.md');
    for (const name of ENV_NAMES) expect(docs, name).toContain(`\`${name}\``);
    const deployedNames = ENV_NAMES.filter((name: string) =>
      !['PORT', 'NODE_ENV', 'NEXT_RUNTIME', 'IMAJIN_APP_PRIVATE_KEY', 'DATABASE_URL', 'MIGRATIONS_TEST_DATABASE_URL'].includes(name));
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
    symlinkSync(realpathSync(join(root, 'node_modules/tsx')), join(checkout, 'node_modules/tsx'), 'dir');
    for (const file of ['scripts/deploy.sh', 'scripts/check-env.mjs', '.env.example']) {
      writeFileSync(join(checkout, file), read(file));
    }
    const env = validEnv();
    writeFileSync(join(checkout, '.env.local'), Object.entries(env).map(([key, value]) =>
      `${key}=${value}`).join('\n'), { mode: 0o600 });
    const recordNode = (name: string) => `
      const fs = process.getBuiltinModule("node:fs");
      if (process.env.IMAJIN_KERNEL_URL !== "https://dev-jin.imajin.ai") process.exit(3);
      if (process.env.DATABASE_URL || process.env.MIGRATIONS_TEST_DATABASE_URL) process.exit(6);
      fs.appendFileSync(process.env.FIXTURE_CALLS, "${name}\\n");
      if (process.env.FIXTURE_FAIL === "${name}") process.exit(4);
    `;
    writeFileSync(join(checkout, 'node_modules/next/dist/bin/next'), recordNode('build'));
    writeFileSync(join(checkout, 'scripts/migrate-baseline.mjs'), recordNode('baseline'));
    writeFileSync(join(checkout, 'scripts/migrate.mjs'), recordNode('migrate'));
    const tool = (name: string, body: string) => writeFileSync(join(bin, name),
      `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    tool('git', '[[ "$1" == status ]] || printf "git %s\\n" "$1" >> "$FIXTURE_CALLS"');
    tool('pnpm', 'printf "install\\n" >> "$FIXTURE_CALLS"');
    tool('pm2', `if [[ "$1" == jlist ]]; then
      printf '%s' "\${FIXTURE_PM2:-[]}"
    else
      [[ -z "\${DATABASE_URL:-}" ]] || exit 5
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
            IMAJIN_KERNEL_URL: 'inherited-fixture-must-not-win',
            ...overrides },
        }),
    };
  }

  it('runs install/build/baseline/migrate before pm2 start/save with file-authoritative env', () => {
    const fixture = deploymentFixture();
    try {
      const result = fixture.run({ MIGRATIONS_TEST_DATABASE_URL: 'FAKE_INHERITED_TEST_OVERRIDE', CI: 'true' });
      expect(result.stderr).toContain('No keystore found — claim at /events/claim after boot');
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
  it.each(['dev', 'prod'])('only warns about a stale platform Stripe key on %s without leaking its value', (target) => {
    const warnings: string[] = [];
    expect(validateEnvironment({
      ...validEnv(target), NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'never-print-stripe-fixture',
    }, target, () => true, warnings)).toEqual([]);
    expect(warnings).toEqual([
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is ignored; the seller's key comes from the kernel. Delete it from the env file.",
    ]);
    expect(warnings.join('\n')).not.toContain('never-print-stripe-fixture');
    const blankWarnings: string[] = [];
    expect(validateEnvironment({
      ...validEnv(target), NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: '',
    }, target, () => true, blankWarnings)).toEqual([]);
    expect(blankWarnings).toEqual([]);
  });
  it.each(['dev', 'prod'])('accepts the %s first-boot contract', (target) => {
    expect(validateEnvironment(validEnv(target), target, () => false)).toEqual([]);
  });

  it('allows a restart without a claim code when a keystore exists', () => {
    const env = validEnv();
    expect(validateEnvironment(env, 'dev', () => true)).toEqual([]);
  });

  it.each(['dev', 'prod'])('only warns on %s first boot with no keystore or claim code', (target) => {
    const env = validEnv(target);
    const warnings: string[] = [];
    expect(validateEnvironment(env, target, () => false, warnings)).toEqual([]);
    expect(warnings.join('\n')).toContain('No keystore found');
    expect(warnings.join('\n')).toContain('claim at /events/claim after boot');

    const withRetiredEnv: string[] = [];
    expect(validateEnvironment({ ...env, IMAJIN_APP_CLAIM_CODE: 'FAKE_IGNORED_CODE' }, target, () => false, withRetiredEnv)).toEqual([]);
    expect(withRetiredEnv).toEqual(warnings);
    expect(withRetiredEnv.join('\n')).not.toContain('FAKE_IGNORED_CODE');
    const withKeystore: string[] = [];
    expect(validateEnvironment(env, target, () => true, withKeystore)).toEqual([]);
    expect(withKeystore).toEqual([]);
  });

  it('exits 0 and warns on an unclaimed first boot without echoing values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-unclaimed-env-'));
    const file = join(dir, '.env.local');
    const env = validEnv();
    env.IMAJIN_APP_KEYSTORE = join(dir, 'events.dev.keystore.json');
    env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'never-print-stripe-fixture';
    try {
      writeFileSync(file, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
      const result = spawnSync(process.execPath, [join(root, 'scripts/check-env.mjs'), 'dev', file], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/^warning: No keystore found/m);
      expect(result.stderr).toContain('claim at /events/claim after boot');
      expect(result.stderr).toContain("warning: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is ignored; the seller's key comes from the kernel. Delete it from the env file.");
      expect(result.stderr).not.toMatch(/^error:/m);
      expect(result.stdout).toContain('Environment validated');
      expect(result.stdout + result.stderr).not.toContain(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing fields and invalid target', () => {
    expect(validateEnvironment({}, 'other')).toEqual(['target must be dev or prod']);
    expect(validateEnvironment({}, 'dev', () => false).join('\n')).toContain('APP_DB_SCHEMA: required');
  });

  it('accepts vault-only self-secrets and ignores stale env placeholders', () => {
    const env = validEnv();
    expect(validateEnvironment(env, 'dev', () => true)).toEqual([]);
    expect(validateEnvironment({
      ...env, SESSION_SECRET: 'FAKE_IGNORED', TICKET_QR_SECRET: 'FAKE_IGNORED',
    }, 'dev', () => true)).toEqual([]);
    for (const name of ['SESSION_SECRET', 'TICKET_QR_SECRET']) {
      expect(ENV_NAMES).not.toContain(name);
      for (const path of ['.env.example', '.env.dev.example', '.env.prod.example',
        'scripts/check-env.mjs', 'docs/ENVIRONMENTS.md', 'docs/DEPLOY.md', 'README.md']) {
        expect(read(path)).not.toContain(name);
      }
    }
  });

  it.each(['DATABASE_URL', 'MIGRATIONS_TEST_DATABASE_URL', 'IMAJIN_APP_PRIVATE_KEY', 'AUTH_INTERNAL_API_KEY', 'PROFILE_INTERNAL_API_KEY',
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
    ['IMAJIN_APP_AUD', 'jin.imajin.ai'], ['ENABLE_TICKET_MIGRATION', 'true'],
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
      expect(rejected.stdout + rejected.stderr).not.toContain(keystore);
      expect(cli('dev', file, 'extra').status).toBe(2);
      expect(cli('dev', join(dir, 'missing')).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('standalone pm2 and deploy contract', () => {
  it('keeps the vault upgrade prerequisite before deployment commands and retains signed callbacks', () => {
    const deploy = read('docs/DEPLOY.md');
    const prerequisite = deploy.indexOf('**Upgrade order (each environment separately):**');
    expect(prerequisite).toBeGreaterThan(-1);
    expect(prerequisite).toBeLessThan(deploy.indexOf('bash scripts/deploy.sh dev'));
    expect(deploy).toContain('ima-jin/imajin-ai#2801');
    expect(deploy).toContain('**Sync manifest secrets**');
    expect(deploy).toContain('**before upgrading this app**');
    expect(deploy).toContain('exit status 1');
    expect(deploy).toContain('## Kernel-signed callbacks');
    expect(deploy).toContain('imajin-ai#2800 / #2798');
    const { dependencies } = JSON.parse(read('package.json'));
    expect(dependencies['@ima-jin/auth']).toBe('0.8.18');
    expect(dependencies['@ima-jin/auth-client']).toBe('0.8.27');
  });
  it('documents fresh vault issuance and QR invalidation at cutover without reissue', () => {
    const deploy = read('docs/DEPLOY.md');
    expect(deploy.split('\n')).toContain('existing ticket QRs are invalidated at cutover; no reissue');
    for (const file of ['docs/DEPLOY.md', 'docs/TICKET-QR.md', 'docs/REGISTRATION.md']) {
      const content = read(file);
      expect(content).toContain('no reissue');
      expect(content).toContain('Never copy the old secret');
      expect(content).not.toContain('reissue through the holder/email paths');
      expect(content).not.toContain('reissue QRs through the same holder/email paths');
      expect(content).not.toContain('holders sign in and load their ticket QR again');
      expect(content).not.toContain('organizers resend ticket emails');
    }
  });
  it('uses canonical standalone paths and original listener ports', () => {
    const { apps } = require('../../ecosystem.config.cjs');
    expect(apps.map((app: { name: string }) => app.name)).toEqual(['dev-events', 'prod-events']);
    for (const [index, target] of ['dev', 'prod'].entries()) {
      const app = apps[index];
      expect(app.cwd).toBe(join(homedir(), target, 'events'));
      expect(app.script).toBe('scripts/start.ts');
      expect(app.env.PORT).toBe(target === 'dev' ? 3006 : 7006);
      expect(app.node_args).toBe(`--import=tsx --env-file=${join(app.cwd, '.env.local')}`);
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
