import { NextResponse } from 'next/server';
import { KernelWebhookError, verifyKernelWebhook, type KernelWebhookNonceStore } from '@ima-jin/auth/kernel-webhook';
import { serviceUrl } from './kernel';
import { createFileWebhookNonceStore } from './kernel-webhook-nonces';

const NONCE_STORE = Symbol.for('@ima-jin/events:kernel-webhook-nonce-store');
type StoreHolder = { [NONCE_STORE]?: KernelWebhookNonceStore };

/** Multi-host replicas must configure a shared, durable, atomic adapter before serving callbacks. */
export function configureEventsWebhookNonceStore(store: KernelWebhookNonceStore): void {
  (globalThis as StoreHolder)[NONCE_STORE] = store;
}

/** Authenticate raw bytes before parsing; the audience is trusted local registration config. */
export async function verifyEventsKernelWebhook<T>(request: Request): Promise<T> {
  const audience = process.env.IMAJIN_APP_DID;
  const authServiceUrl = serviceUrl('auth');
  if (!audience || !/^did:imajin:[a-zA-Z0-9_-]+$/.test(audience) || !authServiceUrl) {
    throw new Error('Kernel webhook verification is not configured');
  }
  // Treat broken local discovery configuration as unavailable, not bad caller authentication.
  const url = new URL(authServiceUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid kernel discovery configuration');
  }
  const holder = globalThis as StoreHolder;
  const nonceStore = holder[NONCE_STORE] ??= createFileWebhookNonceStore();
  return verifyKernelWebhook<T>(request, { audience, authServiceUrl, nonceStore });
}

/** Never expose headers, paths or internal discovery/storage errors. */
export function kernelWebhookFailure(error: unknown): NextResponse {
  if (!(error instanceof KernelWebhookError) || ['STORE', 'DISCOVERY', 'TRUST'].includes(error.code)) {
    return NextResponse.json({ error: 'Webhook verification unavailable' }, { status: 503 });
  }
  const status = error.code === 'INVALID_BODY' ? 400 : 401;
  return NextResponse.json({ error: 'Invalid kernel webhook', code: error.code }, { status });
}
