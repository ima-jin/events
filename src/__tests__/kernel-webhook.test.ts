import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KernelWebhookError } from '@ima-jin/auth/kernel-webhook';
import { kernelWebhookFailure, verifyEventsKernelWebhook } from '@/lib/kernel-webhook';
import { directory, foreignKey, setupKernelWebhooks, signedRequest } from '../../test/kernel-webhook';

setupKernelWebhooks();

describe('kernel webhook boundary', () => {
  it.each(['', 'not-a-did'])('fails closed for invalid local DID %s', async (did) => {
    vi.stubEnv('IMAJIN_APP_DID', did);
    await expect(verifyEventsKernelWebhook(signedRequest('/api/webhook/payment', {}))).rejects.toThrow('not configured');
  });

  it.each(['https://kernel.test/auth?untrusted=1', 'http://public.test/auth', 'ftp://kernel.test/auth', 'invalid-url'])(
    'fails closed for invalid discovery config %s', async (url) => {
      vi.stubEnv('AUTH_SERVICE_URL', url);
      const response = await verifyEventsKernelWebhook(signedRequest('/api/webhook/payment', {})).catch(kernelWebhookFailure);
      expect((response as Response).status).toBe(503);
    },
  );

  it('accepts loopback development discovery without an insecure public fallback', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', 'http://localhost:3000/auth');
    expect(await verifyEventsKernelWebhook(signedRequest('/api/webhook/payment', { ok: true }))).toEqual({ ok: true });
  });

  it('rejects a no-overlap key replacement as trust failure', async () => {
    const root = join(directory, 'data', 'kernel-webhook-pins');
    await mkdir(root, { recursive: true });
    const publicKey = foreignKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const kid = `auth-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
    const hash = createHash('sha256').update(process.env.AUTH_SERVICE_URL!).digest('hex');
    await writeFile(join(root, `${hash}.json`), JSON.stringify([
      { kid, publicKey, algorithm: 'Ed25519', validFrom: new Date(Date.now() - 60_000).toISOString() },
    ]));
    const response = await verifyEventsKernelWebhook(signedRequest('/api/webhook/payment', {})).catch(kernelWebhookFailure);
    expect((response as Response).status).toBe(503);
  });

  it.each(['STORE', 'DISCOVERY', 'TRUST'] as const)('maps %s to a value-free retryable response', async (code) => {
    const response = kernelWebhookFailure(new KernelWebhookError(code, 'private infrastructure detail'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook verification unavailable' });
  });

  it('maps unexpected verification failures to 503 without exposing details', async () => {
    const response = kernelWebhookFailure(new Error('private infrastructure detail'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook verification unavailable' });
  });
});
