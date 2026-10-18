import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBootstrapKeypair, writeKeystore, type AppSecretFetchPayload } from '@ima-jin/auth-client';
import { deriveXKeypairFromEd25519, sealSecret, wrapFieldKey } from '@ima-jin/vault-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../../imajin.app.json';

const { postgresMock, drizzleMock } = vi.hoisted(() => ({
  postgresMock: vi.fn(() => ({ marker: 'FAKE_CLIENT' })),
  drizzleMock: vi.fn(() => ({ marker: 'FAKE_DB', select() { return this.marker; } })),
}));
vi.mock('postgres', () => ({ default: postgresMock }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleMock }));

const BOOT = Symbol.for('imajin.events.vaultBoot');
const slots = globalThis as Record<symbol, unknown>;
const FAKE_DATABASE = 'FAKE_TEST_DATABASE_URL_NOT_A_CONNECTION_STRING';
const sender = deriveXKeypairFromEd25519(generateBootstrapKeypair().privateKey, 'events-test-envelope');
let directory: string;

function sealedResponse(request: AppSecretFetchPayload, value = FAKE_DATABASE, missing = false) {
  const fieldKey = randomBytes(32);
  return Response.json({
    version: 1,
    senderXPub: sender.publicKey,
    wrappedKey: wrapFieldKey(fieldKey, request.recipientXPub, sender.privateKey),
    sealed: sealSecret(JSON.stringify({
      domain: request.domain, appDid: request.appDid, nonce: request.nonce, keys: request.keys,
      values: missing ? {} : { DATABASE_URL: value },
      missing: missing ? ['DATABASE_URL'] : [],
    }), fieldKey),
  });
}

beforeEach(() => {
  delete slots[BOOT];
  vi.resetModules();
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'events-vault-boot-'));
  const keystorePath = join(directory, 'bootstrap.json');
  writeKeystore(keystorePath, generateBootstrapKeypair());
  vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:events-test');
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.example.invalid');
  vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => sealedResponse(JSON.parse(init.body))));
});

afterEach(() => {
  delete slots[BOOT];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe('operator-supplied database pre-import boundary', () => {
  it('declares only current external credential consumers, without values', () => {
    expect(manifest.secrets.filter(({ kind }) => kind === 'operator-supplied'))
      .toEqual([{ name: 'DATABASE_URL', kind: 'operator-supplied' }]);
  });

  it('decrypts the required credential before dynamically importing and initializing the real DB module', async () => {
    let finish!: () => void;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = JSON.parse(init?.body as string);
      expect(request).toMatchObject({
        domain: 'app-self-secrets-v1', appDid: 'did:imajin:events-test', keys: ['DATABASE_URL'],
      });
      expect(typeof request.signature).toBe('string');
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
      await new Promise<void>((resolve) => { finish = resolve; });
      return sealedResponse(request);
    });
    const boot = await import('../vault-boot');
    const server = vi.fn(async () => {
      const { getClient, db } = await import('../../db');
      expect(getClient()).toEqual({ marker: 'FAKE_CLIENT' });
      expect(db.select()).toBe('FAKE_DB');
      expect(db.query).toBeUndefined();
    });
    expect(() => boot.getServerConfig()).toThrow('configuration unavailable');
    const pending = boot.startVaultServer(server);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(server).not.toHaveBeenCalled();
    expect(postgresMock).not.toHaveBeenCalled();
    expect(() => boot.getServerConfig()).toThrow('configuration unavailable');
    finish();
    await pending;
    expect(server).toHaveBeenCalledOnce();
    expect(postgresMock).toHaveBeenCalledOnce();
    expect(postgresMock).toHaveBeenCalledWith(FAKE_DATABASE, { max: 1 });
    expect(drizzleMock).toHaveBeenCalledOnce();
    expect(Object.isFrozen(boot.getServerConfig())).toBe(true);
    expect(process.env.DATABASE_URL).toBeUndefined();
    vi.resetModules();
    const separateBundle = await import('../vault-boot');
    expect(separateBundle.getServerConfig()).toEqual({ databaseUrl: FAKE_DATABASE });
    await expect(boot.startVaultServer(server)).rejects.toThrow('already attempted');
  });

  it('never falls back to an existing DATABASE_URL env value', async () => {
    vi.stubEnv('DATABASE_URL', 'FAKE_IGNORED_ENV_ONLY');
    const { startVaultServer } = await import('../vault-boot');
    await startVaultServer(async () => {
      const { getClient } = await import('../../db');
      getClient();
    });
    expect(postgresMock).toHaveBeenCalledWith(FAKE_DATABASE, { max: 1 });
    expect(process.env.DATABASE_URL).toBe('FAKE_IGNORED_ENV_ONLY');
  });

  it('allows build-time module discovery but rejects database use without initialized configuration', async () => {
    const { db, getClient } = await import('../../db');
    expect(postgresMock).not.toHaveBeenCalled();
    expect(() => getClient()).toThrow('configuration unavailable');
    expect(() => db.select()).toThrow('configuration unavailable');
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it.each(['network', 'refused', 'missing', 'empty', 'blank', 'tampered', 'keystore'])(
    'fails closed on %s without importing server code, constructing a DB or disclosing errors', async (failure) => {
      vi.stubEnv('DATABASE_URL', 'FAKE_IGNORED_ENV_ONLY');
      vi.mocked(fetch).mockImplementation(async (_url, init) => {
        if (failure === 'network') throw new Error('FAKE_PROVIDER_CONTENT_DO_NOT_DISCLOSE');
        if (failure === 'refused') return Response.json({ error: 'FAKE_PROVIDER_CONTENT_DO_NOT_DISCLOSE' }, { status: 403 });
        const request = JSON.parse(init?.body as string);
        if (failure === 'missing') return sealedResponse(request, '', true);
        if (failure === 'empty') return sealedResponse(request, '');
        if (failure === 'blank') return sealedResponse(request, '   ');
        return sealedResponse({ ...request, nonce: 'FAKE_FOREIGN_NONCE' });
      });
      if (failure === 'keystore') vi.stubEnv('IMAJIN_APP_KEYSTORE', join(directory, 'absent.json'));
      const { startVaultServer, getServerConfig } = await import('../vault-boot');
      const server = vi.fn();
      await expect(startVaultServer(server)).rejects.toThrow(/^vault boot: startup failed$/);
      expect(server).not.toHaveBeenCalled();
      expect(postgresMock).not.toHaveBeenCalled();
      expect(() => getServerConfig()).toThrow('configuration unavailable');
    },
  );

  it('revokes configuration and sanitizes server initialization errors', async () => {
    const { startVaultServer, getServerConfig } = await import('../vault-boot');
    await expect(startVaultServer(async () => {
      throw new Error('FAKE_PROVIDER_CONTENT_DO_NOT_DISCLOSE');
    })).rejects.toThrow(/^vault boot: startup failed$/);
    expect(() => getServerConfig()).toThrow('configuration unavailable');
  });

  it('keeps explicit claim-only startup unable to construct a database or switch modes', async () => {
    const { startClaimServer, startVaultServer, isClaimOnly } = await import('../vault-boot');
    expect(isClaimOnly()).toBe(false);
    await startClaimServer(async () => {
      const { getClient } = await import('../../db');
      expect(() => getClient()).toThrow('configuration unavailable');
    });
    expect(isClaimOnly()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(postgresMock).not.toHaveBeenCalled();
    await expect(startVaultServer(vi.fn())).rejects.toThrow('already attempted');
    await expect(startClaimServer(vi.fn())).rejects.toThrow('already attempted');
  });
});
