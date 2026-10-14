import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { canonicalKernelWebhookPayload } from '@ima-jin/auth/kernel-webhook';

// Ephemeral keys only; no fixture contains private key material.
export const signingKey = generateKeyPairSync('ed25519');
export const foreignKey = generateKeyPairSync('ed25519');
export const publicKey = signingKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
export const kid = `auth-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
export const audience = 'did:imajin:events-test';
export const directory = mkdtempSync(join(tmpdir(), 'events-kernel-webhooks-'));
export const discovery = vi.fn();

export function setupKernelWebhooks(): void {
  let cwd: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
  });
  beforeEach(() => {
    vi.stubEnv('IMAJIN_APP_DID', audience);
    // A unique trusted namespace gives each case independent discovery/pin state.
    vi.stubEnv('AUTH_SERVICE_URL', `https://kernel.test/${randomUUID()}/auth`);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@ima-jin/events:kernel-webhook-nonce-store')];
    discovery.mockReset().mockResolvedValue(Response.json({
      current: kid,
      keys: [{ kid, publicKey, algorithm: 'Ed25519', validFrom: new Date(Date.now() - 60_000).toISOString() }],
    }));
    vi.stubGlobal('fetch', discovery);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    cwd.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });
}

export interface SignedRequestOptions {
  timestampOffsetSeconds?: number;
  audience?: string;
  privateKey?: typeof signingKey.privateKey;
  signedUrl?: string;
  signedMethod?: string;
  unsigned?: boolean;
  tampered?: boolean;
  headers?: Record<string, string>;
}

export function signedRequest(path: string, body: unknown, options: SignedRequestOptions = {}): Request {
  const url = `https://events.test/events${path}`;
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) + (options.timestampOffsetSeconds ?? 0));
  const nonce = randomUUID();
  const recipient = options.audience ?? audience;
  const canonical = canonicalKernelWebhookPayload({
    audience: recipient, timestamp, nonce, method: options.signedMethod ?? 'POST',
    url: options.signedUrl ?? url, rawBody,
  });
  const headers = new Headers({ 'Content-Type': 'application/json', ...options.headers });
  if (!options.unsigned) {
    headers.set('x-kernel-audience', recipient);
    headers.set('x-kernel-kid', kid);
    headers.set('x-kernel-timestamp', timestamp);
    headers.set('x-kernel-nonce', nonce);
    headers.set('x-kernel-signature', sign(null, Buffer.from(canonical), options.privateKey ?? signingKey.privateKey).toString('hex'));
  }
  return new Request(url, {
    method: 'POST', headers, body: options.tampered ? `${rawBody} ` : rawBody,
  });
}
