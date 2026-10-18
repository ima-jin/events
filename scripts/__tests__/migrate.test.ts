import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { loadFromVault } from '@ima-jin/auth-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkFile } from '../check-env.mjs';
import { loadMigrationDatabaseUrl } from '../lib/migration-credentials.mjs';
import { main as migrateMain } from '../migrate.mjs';
import { main as baselineMain } from '../migrate-baseline.mjs';
import { validEnv } from './support/deploy-env';

const { migrateMock, drizzleMock } = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => {}),
  drizzleMock: vi.fn((client: unknown) => ({ client })),
}));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleMock }));
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: migrateMock }));
vi.mock('@ima-jin/auth-client', async (original) => ({
  ...await original<typeof import('@ima-jin/auth-client')>(), loadFromVault: vi.fn(),
}));

type Cli = (args: string[], env: Record<string, string | undefined>, connect?: unknown, logger?: unknown) => Promise<number>;
const migrate = migrateMain as unknown as Cli;
const baseline = baselineMain as unknown as Cli;
const FAKE_DATABASE = 'FAKE_TEST_DATABASE_URL_NOT_A_CONNECTION_STRING';
const output = () => ({ log: vi.fn(), error: vi.fn() });

function clientFixture() {
  const tx = { unsafe: vi.fn(async () => [{ exists: false }]) };
  return { begin: async (callback: (tx: unknown) => unknown) => callback(tx), end: vi.fn(async () => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadFromVault).mockResolvedValue({ values: { DATABASE_URL: FAKE_DATABASE }, degraded: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('vault-only deploy baseline and migrations', () => {
  it('accepts a check-env-valid credential-free file and completes baseline plus migrate through the mocked vault', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'events-vault-migration-'));
    try {
      const file = join(directory, '.env.local');
      const keystore = join(directory, 'events.dev.keystore.json');
      writeFileSync(keystore, '{}', { mode: 0o600 }); // Metadata fixture only; SDK fetch is mocked.
      writeFileSync(file, Object.entries({ ...validEnv(), IMAJIN_APP_KEYSTORE: keystore })
        .map(([name, value]) => `${name}=${value}`).join('\n'), { mode: 0o600 });
      expect(checkFile('dev', file)).toEqual([]);
      const env = parseEnv(readFileSync(file, 'utf8'));
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.MIGRATIONS_TEST_DATABASE_URL).toBeUndefined();
      const sql = clientFixture();
      const connect = vi.fn(() => sql);
      const logger = output();
      expect(await baseline([], env, connect, logger)).toBe(0);
      expect(await migrate([], env, connect, logger)).toBe(0);
      expect(loadFromVault).toHaveBeenCalledTimes(2);
      expect(loadFromVault).toHaveBeenCalledWith({
        appDid: env.IMAJIN_APP_DID, kernelUrl: env.IMAJIN_KERNEL_URL, keystorePath: keystore,
        keys: [{ key: 'DATABASE_URL', onMissing: 'fail' }],
      });
      expect(connect).toHaveBeenCalledWith(FAKE_DATABASE, { max: 1, onnotice: expect.any(Function) });
      expect(migrateMock).toHaveBeenCalledWith({ client: sql }, {
        migrationsFolder: expect.stringMatching(/\/migrations$/), migrationsSchema: 'events',
      });
      expect(sql.end).toHaveBeenCalledTimes(2);
      expect(JSON.stringify([logger.log.mock.calls, logger.error.mock.calls])).not.toContain(FAKE_DATABASE);
      expect(env.DATABASE_URL).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores even a populated legacy DATABASE_URL and fetches from the vault', async () => {
    expect(await loadMigrationDatabaseUrl({ ...validEnv(), DATABASE_URL: 'FAKE_IGNORED_ENV_ONLY' }))
      .toBe(FAKE_DATABASE);
    expect(loadFromVault).toHaveBeenCalledOnce();
  });

  it.each([undefined, '', '   '])('rejects unavailable/blank vault credentials (%s)', async (value) => {
    const values: Record<string, string> = {};
    if (value !== undefined) values.DATABASE_URL = value;
    vi.mocked(loadFromVault).mockResolvedValue({ values, degraded: [] });
    const connect = vi.fn();
    expect(await migrate([], validEnv(), connect, output())).toBe(2);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([baseline, migrate])('fails closed and sanitizes vault failures before connecting', async (runner) => {
    vi.mocked(loadFromVault).mockRejectedValueOnce(new Error('FAKE_PROVIDER_CONTENT_DO_NOT_DISCLOSE'));
    const connect = vi.fn();
    const logger = output();
    expect(await runner([], { ...validEnv(), DATABASE_URL: 'FAKE_IGNORED_ENV_ONLY' }, connect, logger)).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('FAKE_PROVIDER_CONTENT_DO_NOT_DISCLOSE');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('FAKE_IGNORED_ENV_ONLY');
  });

  it.each([{ CI: 'true' }, { NODE_ENV: 'test' }])('allows only an explicit disposable test/CI input: %j', async (mode) => {
    expect(await loadMigrationDatabaseUrl({ ...mode, MIGRATIONS_TEST_DATABASE_URL: FAKE_DATABASE })).toBe(FAKE_DATABASE);
    expect(loadFromVault).not.toHaveBeenCalled();
    const sql = clientFixture();
    expect(await migrate([], { ...mode, MIGRATIONS_TEST_DATABASE_URL: FAKE_DATABASE }, () => sql, output())).toBe(0);
    expect(sql.end).toHaveBeenCalledOnce();
  });

  it.each([{}, { NODE_ENV: 'production' }, { CI: 'false' }])('refuses a test override outside test/CI: %j', async (mode) => {
    await expect(loadMigrationDatabaseUrl({ ...mode, MIGRATIONS_TEST_DATABASE_URL: FAKE_DATABASE }))
      .rejects.toThrow('Migration database credential unavailable');
    expect(loadFromVault).not.toHaveBeenCalled();
  });

  it('rejects a blank explicit test input rather than falling back', async () => {
    await expect(loadMigrationDatabaseUrl({ NODE_ENV: 'test', MIGRATIONS_TEST_DATABASE_URL: '' })).rejects.toThrow('unavailable');
    expect(loadFromVault).not.toHaveBeenCalled();
  });

  it('rejects arguments and foreign schema before vault or database activity', async () => {
    const connect = vi.fn();
    expect(await migrate(['FAKE_UNTRUSTED_ARGUMENT'], validEnv(), connect, output())).toBe(2);
    expect(await migrate([], { ...validEnv(), APP_DB_SCHEMA: 'public' }, connect, output())).toBe(2);
    expect(loadFromVault).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('sanitizes database/migrator failures and always closes the connection', async () => {
    migrateMock.mockRejectedValueOnce(new Error(FAKE_DATABASE));
    const sql = clientFixture();
    sql.end.mockRejectedValueOnce(new Error(FAKE_DATABASE));
    const logger = output();
    expect(await migrate([], validEnv(), () => sql, logger)).toBe(2);
    expect(sql.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(FAKE_DATABASE);
  });

  it('deploy invokes both vault-aware runners and never the migration CLI', () => {
    const script = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
    expect(script).toContain('node --import=tsx --env-file=.env.local scripts/migrate-baseline.mjs');
    expect(script).toContain('node --import=tsx --env-file=.env.local scripts/migrate.mjs');
    expect(script).not.toContain('node_modules/drizzle-kit/bin.cjs migrate');
    expect(script).toContain('"/scripts/start.ts"');
  });

  it.each(['scripts/migrate-baseline.mjs', 'scripts/migrate.mjs'])(
    'runs %s through the public SDK ESM path and fails closed without a keystore', (script) => {
      const result = spawnSync(process.execPath, ['--import=tsx', script], {
        encoding: 'utf8', timeout: 10_000,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME,
          IMAJIN_APP_DID: 'did:imajin:fixture', IMAJIN_KERNEL_URL: 'https://kernel.example.invalid',
          IMAJIN_APP_KEYSTORE: '/fixture/absent-migration-keystore.json', APP_DB_SCHEMA: 'events',
          NODE_ENV: 'production',
        },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No credentials are printed.');
      expect(result.stderr).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    },
  );
});
