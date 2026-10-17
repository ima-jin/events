import { createLogger } from '@ima-jin/logger';
import { createAppServiceTokenProvider, type AppServiceTokenProvider } from '@ima-jin/auth-client';
import { kernelBaseUrl } from './kernel';
import { getSigningIdentity } from './signing-identity';

/**
 * Domain-event publisher — replaces the kernel's in-process `@imajin/bus`
 * `publish()`. The bus is kernel-internal; this app emits `event.*` /
 * `ticket.*` / `order.*` / `checkin.*` events by calling the kernel's
 * app-service-token-gated POST /api/events instead of importing a publisher.
 * The kernel stamps issuer/scope and runs notify/audit only, never settlement
 * or attestation issuance. The manifest declares types; the operator approves.
 */

const log = createLogger('events');
const PROVIDER_KEY = Symbol.for('@ima-jin/events:domain-event-token-provider');
interface ProviderStore {
  [PROVIDER_KEY]?: {
    identity: ReturnType<typeof getSigningIdentity>;
    kernelUrl: string;
    provider: AppServiceTokenProvider;
  };
}

function tokenProvider(kernelUrl: string): AppServiceTokenProvider {
  const identity = getSigningIdentity();
  if (identity.appDid !== process.env.IMAJIN_APP_DID) {
    throw new Error('Signing identity does not match IMAJIN_APP_DID');
  }
  const store = globalThis as ProviderStore;
  let cached = store[PROVIDER_KEY];
  if (cached?.identity !== identity || cached.kernelUrl !== kernelUrl) {
    cached = {
      identity,
      kernelUrl,
      provider: createAppServiceTokenProvider({
        kernelUrl,
        appDid: identity.appDid,
        privateKey: identity.privateKey,
        fetchOptions: { redirect: 'error' },
      }),
    };
    store[PROVIDER_KEY] = cached;
  }
  return cached.provider;
}

function publishUrl(): string | null {
  const base = kernelBaseUrl();
  if (!base) {
    log.error({}, 'Domain event not delivered: IMAJIN_KERNEL_URL (or IMAJIN_AUTH_URL) is not set');
    return null;
  }
  const path = process.env.IMAJIN_EVENTS_PUBLISH_PATH || '/api/events';
  try {
    const url = new URL(`${base}${path}`);
    const origin = new URL(base);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== origin.origin ||
        !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid publish URL');
    }
    return url.href;
  } catch {
    log.error({}, 'Domain event not delivered: invalid IMAJIN_KERNEL_URL / IMAJIN_AUTH_URL or IMAJIN_EVENTS_PUBLISH_PATH (must be a kernel-relative path)');
    return null;
  }
}

export interface DomainEvent {
  issuer: string;
  subject: string;
  scope: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  timestamp?: string;
}

export interface PublishResult {
  attestationId?: string;
}

/**
 * Publish a domain event. Never throws — callers treat publishing as
 * best-effort, exactly as the kernel routes did (`.catch(log)`).
 */
export async function publish(type: string, event: DomainEvent): Promise<PublishResult> {
  // Settlement assertions belong to the kernel, not an app's notification channel.
  if (!['event', 'ticket', 'order', 'checkin'].includes(type.split('.')[0])) {
    log.error({ type }, 'Domain event not delivered: only event.*, ticket.*, order.* and checkin.* are app domain events');
    return {};
  }
  const url = publishUrl();
  if (!url) return {};
  if (!process.env.IMAJIN_APP_DID) {
    log.error({ type }, 'Domain event not delivered: IMAJIN_APP_DID is not set');
    return {};
  }
  let provider: AppServiceTokenProvider;
  let token: string;
  try {
    provider = tokenProvider(kernelBaseUrl()!);
    token = await provider.getToken();
  } catch {
    // Never log SDK exceptions: they may contain credentials or response bodies.
    log.error({ type }, 'Domain event not delivered: app-service token unavailable; check IMAJIN_APP_DID, IMAJIN_APP_KEYSTORE and signing identity provisioning at /events/claim');
    return {};
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type,
        subject: event.subject,
        payload: event.payload,
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      }),
    });
    if (!response.ok) {
      if (response.status === 401) provider.invalidate();
      log.error(
        { type, status: response.status, retryAfter: response.headers.get('Retry-After') },
        'Domain event rejected by kernel; check app-service authentication and operator-approved emittable_events (403); no automatic retry',
      );
    }
  } catch {
    log.error({ type }, 'Domain event delivery failed: kernel request unavailable; no automatic retry');
  }
  return {};
}
