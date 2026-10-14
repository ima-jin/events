import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapSigningIdentity, resetSigningIdentityForTests } from '@/lib/signing-identity';
import { resetClaimRateLimitForTests } from '@/lib/claim-rate-limit';
import { NextRequest } from 'next/server';
import { middleware } from '../../../../middleware';
import { GET as health } from '../../health/route';
import { POST } from '../route';
import { loadFromVault } from '@ima-jin/auth-client';
import { resetSelfSecretsForTests } from '@/lib/self-secrets';
vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  loadFromVault: vi.fn(),
}));

const KERNEL_URL = 'https://dev-jin.imajin.test';
const RATE_LIMIT = 5;

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

}

function mockKernelClaim(responseBody: Record<string, unknown>, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(responseBody), { status, headers: { 'Content-Type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('POST /api/claim', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'imajin-claim-route-'));
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', join(workDir, 'keystore.json'));
    vi.stubEnv('IMAJIN_APP_DID', '');
    vi.mocked(loadFromVault).mockResolvedValue({
      values: {
        SESSION_SECRET: 'FAKE_SESSION_TEST_ONLY_'.repeat(4),
        TICKET_QR_SECRET: 'FAKE_QR_TEST_ONLY_'.repeat(4),
      }, degraded: [],
    });
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    resetSelfSecretsForTests();
    resetClaimRateLimitForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('redeems a valid claim code, persists a 0600 keystore, and never returns the private key', async () => {
    mockKernelClaim({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    const response = await POST(postRequest({ claimCode: 'operator-pasted-code' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ appDid: 'did:imajin:app-under-test', publicKey: 'signing-public-key-hex' });
    expect(body.privateKey).toBeUndefined();

    const keystoreStat = await stat(join(workDir, 'keystore.json'));
    expect(keystoreStat.mode & 0o777).toBe(0o600);
  });

  it('boots unclaimed, ignores IMAJIN_APP_CLAIM_CODE, and becomes live after browser claim without restarting', async () => {
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', 'FAKE_IGNORED_ENV_CODE');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const fetchMock = mockKernelClaim({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'FAKE_SIGNING_KEY_NOT_A_SECRET',
      publicKey: 'FAKE_PUBLIC_KEY',
    });
    const request = () => new NextRequest('http://localhost:3000/api/spec');
    await bootstrapSigningIdentity();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await health().json()).toMatchObject({ status: 'ok', claimed: false });
    expect(await middleware(request()).text()).toContain('href="/events/claim"');

    const response = await POST(postRequest({ claimCode: 'FAKE_BROWSER_CODE_NOT_A_SECRET' }) as never);

    expect(response.status).toBe(200);
    expect(await health().json()).toMatchObject({ status: 'ok', claimed: true });
    expect(middleware(request()).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(new NextRequest('http://localhost:3000/claim')).status).toBe(404);
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('FAKE_BROWSER_CODE_NOT_A_SECRET');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('FAKE_IGNORED_ENV_CODE');
    expect(JSON.stringify(await health().json())).not.toContain('FAKE_');
  });

  it('rejects a missing claim code without calling the kernel', async () => {
    const fetchMock = mockKernelClaim({});

    const response = await POST(postRequest({}) as never);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a kernel refusal to a generic 400 without leaking the kernel error body', async () => {
    mockKernelClaim({ error: 'This claim code has already been redeemed' }, 410);

    const response = await POST(postRequest({ claimCode: 'spent-code' }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Unable to redeem this claim code' });
  });

  it.each([null, {}, { claimCode: 42 }, { claimCode: '   ' }, { claimCode: 'x'.repeat(201) }])(
    'rejects invalid claim input without contacting the kernel: %j', async (body) => {
      const fetchMock = mockKernelClaim({});
      expect((await POST(postRequest(body) as never)).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed JSON', async () => {
    const request = new Request('http://localhost:3000/events/api/claim', { method: 'POST', body: '{' });
    expect((await POST(request as never)).status).toBe(400);
  });

  it('never logs an SDK error that echoes a claim code or key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('operator-code private-key')));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await POST(postRequest({ claimCode: 'operator-code' }) as never);
    expect(response.status).toBe(400);
    expect(log).toHaveBeenCalledWith('POST /api/claim: claim exchange failed');
    expect(JSON.stringify(log.mock.calls)).not.toContain('operator-code');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-key');
  });

  it('uses the shared fallback rate-limit bucket for missing or empty proxy addresses', async () => {
    mockKernelClaim({ error: 'refused' }, 400);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await POST(postRequest({ claimCode: 'invalid' }, { 'x-forwarded-for': ' , ' }) as never);
    }
    expect((await POST(postRequest({ claimCode: 'invalid' }) as never)).status).toBe(429);
  });

  it('404s once this app is already claimed', async () => {
    mockKernelClaim({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });
    await POST(postRequest({ claimCode: 'first-code' }) as never);

    const response = await POST(postRequest({ claimCode: 'second-code' }) as never);

    expect(response.status).toBe(404);
  });

  it('rate-limits repeated attempts from the same client', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(postRequest({ claimCode: `attempt-${attempt}` }, { 'x-forwarded-for': '203.0.113.5' }) as never);
    }
    const response = await POST(
      postRequest({ claimCode: 'one-attempt-too-many' }, { 'x-forwarded-for': '203.0.113.5' }) as never
    );

    expect(response.status).toBe(429);
  });

  it('keys the rate limit on the trusted LAST X-Forwarded-For hop, not the spoofable leading one', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    // A different, attacker-controlled leading hop on every request, but the
    // same trailing hop — the one this app's own front-door proxy actually
    // appends. If the limiter (still, wrongly) keyed on the first hop, this
    // loop would never trip the limit at all.
    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(
        postRequest({ claimCode: `attempt-${attempt}` }, { 'x-forwarded-for': `10.0.0.${attempt}, 203.0.113.5` }) as never
      );
    }
    const response = await POST(
      postRequest({ claimCode: 'one-attempt-too-many' }, { 'x-forwarded-for': '10.0.0.99, 203.0.113.5' }) as never
    );

    expect(response.status).toBe(429);
  });

  it('ignores a spoofed x-real-ip header and still rate-limits by last XFF hop', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    // A fresh fabricated x-real-ip on every request, but the same trailing
    // x-forwarded-for hop. If the limiter trusted x-real-ip, every request
    // would land in its own bucket and this loop would never trip the limit.
    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(
        postRequest(
          { claimCode: `attempt-${attempt}` },
          { 'x-real-ip': `198.51.100.${attempt}`, 'x-forwarded-for': '203.0.113.5' }
        ) as never
      );
    }
    const response = await POST(
      postRequest(
        { claimCode: 'one-attempt-too-many' },
        { 'x-real-ip': '198.51.100.99', 'x-forwarded-for': '203.0.113.5' }
      ) as never
    );

    expect(response.status).toBe(429);
  });

  it('refuses a claim whose kernel-returned appDid does not match IMAJIN_APP_DID, and persists nothing', async () => {
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:this-app');
    mockKernelClaim({
      appDid: 'did:imajin:a-different-app',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    const response = await POST(postRequest({ claimCode: 'operator-pasted-code' }) as never);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.expectedAppDid).toBe('did:imajin:this-app');
    expect(body.claimedAppDid).toBe('did:imajin:a-different-app');
    expect(body.error).not.toContain('operator-pasted-code');
    expect(existsSync(join(workDir, 'keystore.json'))).toBe(false);
  });
});
