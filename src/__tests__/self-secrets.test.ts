import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionToken, verifySessionToken, loadFromVault, loadAppSigningKey, readKeystore,
  type AppVaultCredentials,
} from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';
import { register } from '../../instrumentation';
import { authConfig } from '@/lib/auth-config';
import { getSelfSecret, loadSelfSecrets, resetSelfSecretsForTests, warnIgnoredSelfSecretEnv } from '@/lib/self-secrets';
import {
  bootstrapSigningIdentity, claimWithCode, getSigningIdentity, isAppClaimed,
  resetSigningIdentityForTests,
} from '@/lib/signing-identity';
import { createTicketQrToken, verifyTicketQrToken } from '@/lib/ticket-qr-token';
import { POST } from '../../app/api/claim/route';
import { NextRequest } from 'next/server';
import { GET as session } from '../../app/api/auth/session/route';

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}));

vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  loadFromVault: vi.fn(),
  loadAppSigningKey: vi.fn(),
  readKeystore: vi.fn(),
}));

const APP_DID = 'did:imajin:events-fixture';
const FAKE_SESSION = 'FAKE_SESSION_TEST_ONLY_'.repeat(4);
const FAKE_QR = 'FAKE_QR_TEST_ONLY_'.repeat(4);
const credentials = (): AppVaultCredentials => ({
  values: { SESSION_SECRET: FAKE_SESSION, TICKET_QR_SECRET: FAKE_QR }, degraded: [],
});
const identity = { appDid: APP_DID, privateKey: 'FAKE_SIGNING_KEY_ONLY', publicKey: 'FAKE_PUBLIC_KEY_ONLY' };
const user = { did: 'did:imajin:test-user', displayName: 'Test', handle: 'test', attestationId: 'att_test' };

beforeEach(() => {
  vi.resetAllMocks();
  resetSelfSecretsForTests();
  resetSigningIdentityForTests();
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
  vi.stubEnv('IMAJIN_APP_DID', APP_DID);
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.test');
  vi.stubEnv('IMAJIN_APP_KEYSTORE', '/fixture/events.dev.keystore.json');
  vi.stubEnv('SESSION_SECRET', undefined);
  vi.stubEnv('TICKET_QR_SECRET', undefined);
  vi.mocked(readKeystore).mockReturnValue({ privateKey: 'FAKE_BOOTSTRAP_ONLY', publicKey: 'FAKE_PUBLIC_ONLY' });
  vi.mocked(loadAppSigningKey).mockResolvedValue(identity);
  vi.mocked(loadFromVault).mockResolvedValue(credentials());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSelfSecretsForTests();
  resetSigningIdentityForTests();
});

describe('declared app-keystore self-secrets', () => {
  it('boots with no env self-secrets and signs sessions and unchanged ticket-v1 QRs', async () => {
    expect(manifest.secrets).toEqual([
      { name: 'SESSION_SECRET', kind: 'random-32B' },
      { name: 'TICKET_QR_SECRET', kind: 'random-32B' },
    ]);
    await register();
    expect(isAppClaimed()).toBe(true);
    expect(getSigningIdentity()).toEqual(identity);
    for (const { name } of manifest.secrets) {
      expect(loadFromVault).toHaveBeenCalledWith({
        appDid: APP_DID, kernelUrl: 'https://kernel.test',
        keystorePath: '/fixture/events.dev.keystore.json',
        keys: [{ key: name, onMissing: 'fail' }],
      });
      expect(process.env[name]).toBeUndefined();
    }
    expect(await verifySessionToken(await createSessionToken(user, authConfig), authConfig)).toMatchObject(user);
    const payload = Buffer.from(JSON.stringify({ ticketId: 'tkt_fixture' })).toString('base64url');
    const mac = createHmac('sha256', FAKE_QR).update(`ticket-v1.${payload}`).digest('base64url');
    const token = createTicketQrToken('tkt_fixture');
    expect(token).toBe(`ticket-v1.${payload}.${mac}`);
    expect(verifyTicketQrToken(token, 'tkt_fixture')).toBe(true);
  });

  it('serves the signed-in session endpoint using a vault-signed cookie', async () => {
    await register();
    cookieGet.mockReturnValue({ value: await createSessionToken(user, authConfig) });
    const response = await session();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(user);
    expect(cookieGet).toHaveBeenCalledWith('imajin_session');
  });

  it('ignores conflicting env credentials on success and never writes vault values into env', async () => {
    vi.stubEnv('SESSION_SECRET', 'FAKE_IGNORED_ENV_SESSION');
    vi.stubEnv('TICKET_QR_SECRET', 'FAKE_IGNORED_ENV_QR');
    await register();
    expect(authConfig.secret).toBe(FAKE_SESSION);
    expect(getSelfSecret('TICKET_QR_SECRET')).toBe(FAKE_QR);
    expect(process.env.SESSION_SECRET).toBe('FAKE_IGNORED_ENV_SESSION');
    expect(process.env.TICKET_QR_SECRET).toBe('FAKE_IGNORED_ENV_QR');
    vi.resetModules();
    const separateBundle = await import('@/lib/self-secrets');
    expect(separateBundle.getSelfSecret('SESSION_SECRET')).toBe(FAKE_SESSION);
  });

  it('does not serve secret-dependent operations or activate identity while boot loading is pending', async () => {
    let finish!: (value: AppVaultCredentials) => void;
    vi.mocked(loadFromVault).mockResolvedValueOnce(credentials())
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const boot = register();
    await vi.waitFor(() => expect(loadFromVault).toHaveBeenCalledTimes(2));
    expect(isAppClaimed()).toBe(false);
    expect(() => authConfig.secret).toThrow('SESSION_SECRET');
    expect(() => createTicketQrToken('tkt_fixture')).toThrow('TICKET_QR_SECRET');
    finish(credentials());
    await boot;
    expect(isAppClaimed()).toBe(true);
  });

  it.each(['SESSION_SECRET', 'TICKET_QR_SECRET'] as const)(
    'fails closed for unreachable vault while fetching %s, sanitizing provider errors', async (name) => {
      vi.stubEnv('SESSION_SECRET', FAKE_SESSION);
      vi.stubEnv('TICKET_QR_SECRET', FAKE_QR);
      vi.mocked(loadFromVault).mockImplementation(async (options) => {
        if (options.keys[0].key === name) throw new Error('FAKE_UNTRUSTED_PROVIDER_CONTENT');
        return credentials();
      });
      await expect(bootstrapSigningIdentity()).rejects.toThrow(
        `${name}: vault secret unavailable; on /jin use Sync manifest secrets and countersign, then restart events.`,
      );
      expect(isAppClaimed()).toBe(false);
      expect(() => authConfig.secret).toThrow('SESSION_SECRET');
      expect(() => getSelfSecret('TICKET_QR_SECRET')).toThrow('TICKET_QR_SECRET');
    },
  );

  it.each(['SESSION_SECRET', 'TICKET_QR_SECRET'] as const)(
    'rejects missing, empty and weak %s without publishing partial values', async (name) => {
      for (const value of [undefined, '', 'FAKE_SHORT']) {
        const result = credentials();
        if (value === undefined) delete result.values[name];
        else result.values[name] = value;
        vi.mocked(loadFromVault).mockResolvedValue(result);
        await expect(bootstrapSigningIdentity()).rejects.toThrow(name);
        expect(() => getSelfSecret('SESSION_SECRET')).toThrow('/jin');
        expect(() => getSelfSecret('TICKET_QR_SECRET')).toThrow('/jin');
        expect(isAppClaimed()).toBe(false);
      }
    },
  );

  it('fetches rotated generations on restart without a file/env edit', async () => {
    await register();
    const oldSession = await createSessionToken(user, authConfig);
    const oldQr = createTicketQrToken('tkt_fixture');
    vi.mocked(loadFromVault).mockResolvedValue({
      values: {
        SESSION_SECRET: 'FAKE_ROTATED_SESSION_TEST_ONLY_'.repeat(4),
        TICKET_QR_SECRET: 'FAKE_ROTATED_QR_TEST_ONLY_'.repeat(4),
      }, degraded: [],
    });
    resetSigningIdentityForTests();
    resetSelfSecretsForTests();
    await register();
    expect(loadFromVault).toHaveBeenCalledTimes(4);
    expect(await verifySessionToken(oldSession, authConfig)).toBeNull();
    expect(verifyTicketQrToken(oldQr, 'tkt_fixture')).toBe(false);
    expect(await verifySessionToken(await createSessionToken(user, authConfig), authConfig)).toMatchObject(user);
    expect(verifyTicketQrToken(createTicketQrToken('tkt_fixture'), 'tkt_fixture')).toBe(true);
  });

  it('drops cached credentials after a failed reload', async () => {
    await loadSelfSecrets(APP_DID);
    vi.mocked(loadFromVault).mockRejectedValue(new Error('FAKE_PROVIDER_FAILURE'));
    await expect(loadSelfSecrets(APP_DID)).rejects.toThrow('SESSION_SECRET');
    expect(() => getSelfSecret('SESSION_SECRET')).toThrow('/jin');
  });

  it.each(['SESSION_SECRET', 'TICKET_QR_SECRET'] as const)(
    'logs one safe boot error and exits 1 when %s cannot load', async (name) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('FAKE_PROCESS_EXIT'); });
      vi.mocked(loadFromVault).mockImplementation(async (options) => {
        if (options.keys[0].key === name) throw new Error('FAKE_UNTRUSTED_PROVIDER_CONTENT');
        return credentials();
      });
      await expect(register()).rejects.toThrow('FAKE_PROCESS_EXIT');
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        `${name}: vault secret unavailable; on /jin use Sync manifest secrets and countersign, then restart events.`,
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('FAKE_UNTRUSTED_PROVIDER_CONTENT');
    },
  );

  it('warns about stale env credentials by name only, never logging their values', async () => {
    vi.stubEnv('SESSION_SECRET', 'FAKE_IGNORED_ENV_SESSION');
    vi.stubEnv('TICKET_QR_SECRET', 'FAKE_IGNORED_ENV_QR');
    await register();
    expect(console.warn).toHaveBeenCalledTimes(2);
    for (const { name } of manifest.secrets) {
      expect(console.warn).toHaveBeenCalledWith(
        `${name} is ignored; it is issued by the kernel vault. Delete it from the env file.`,
      );
    }
    const warnings = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(warnings).not.toContain('FAKE_IGNORED_ENV_SESSION');
    expect(warnings).not.toContain('FAKE_IGNORED_ENV_QR');
    expect(warnings).not.toContain(FAKE_SESSION);
    expect(warnings).not.toContain(FAKE_QR);
  });

  it('does not warn when self-secret env entries are absent', () => {
    warnIgnoredSelfSecretEnv();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('keeps the unclaimed browser gate without fetching anything from the vault', async () => {
    vi.mocked(readKeystore).mockReturnValue(null);
    await bootstrapSigningIdentity();
    expect(loadAppSigningKey).not.toHaveBeenCalled();
    expect(loadFromVault).not.toHaveBeenCalled();
    expect(isAppClaimed()).toBe(false);
    expect(() => authConfig.secret).toThrow('/jin');
  });

  it('loads required secrets after browser claim and before activating identity', async () => {
    await claimWithCode({ claimCode: 'FAKE_CLAIM_TEST_ONLY' });
    expect(loadAppSigningKey).toHaveBeenCalledWith({ claimCode: 'FAKE_CLAIM_TEST_ONLY', hostHint: undefined });
    expect(vi.mocked(loadAppSigningKey).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(loadFromVault).mock.invocationCallOrder[0]);
    expect(isAppClaimed()).toBe(true);
    expect(authConfig.secret).toBe(FAKE_SESSION);
  });

  it('logs one safe, actionable line and returns 503 if browser claim cannot load vault secrets', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadFromVault).mockRejectedValue(new Error('FAKE_UNTRUSTED_PROVIDER_CONTENT'));
    const response = await POST(new NextRequest('https://events.test/api/claim', {
      method: 'POST', headers: { 'x-forwarded-for': '192.0.2.39' },
      body: JSON.stringify({ claimCode: 'FAKE_CLAIM_TEST_ONLY' }),
    }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(body.error);
    expect(body.error).toMatch(/^SESSION_SECRET:.*\/jin.*Sync manifest secrets/);
    expect(body.error).not.toContain('FAKE_UNTRUSTED_PROVIDER_CONTENT');
    expect(body.error).not.toContain('FAKE_CLAIM_TEST_ONLY');
    expect(isAppClaimed()).toBe(false);
  });
});
