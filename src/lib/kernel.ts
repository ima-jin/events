import { createLogger } from '@ima-jin/logger';
import { getPayAppToken, invalidatePayAppToken } from './pay-app-token';

/**
 * Public kernel API client — the ONLY way this app reads or writes anything
 * the kernel owns (identities, profiles, pods, onboarding, surveys, payments,
 * chat). The kernel's Postgres schemas are never touched directly; see
 * docs/MIGRATIONS.md.
 *
 * Legacy calls use registration headers; scoped helpers below use the app's
 * existing service JWT without forwarding caller cookies:
 *   X-App-DID            — IMAJIN_APP_DID
 *   X-App-Authorization  — IMAJIN_APP_ATTESTATION_ID (service-level attestation)
 *
 * Every helper is non-throwing: the kernel being unreachable, or not yet
 * exposing a route this app needs, degrades to a documented fallback value
 * and a log line — mirroring the best-effort semantics the kernel version
 * of these code paths already had. Routes the kernel does not yet expose to
 * registered apps are tracked as `gap(kernel)` issues (refs
 * ima-jin/imajin-ai#1988); see docs/KERNEL-GAPS.md.
 */

const log = createLogger('events');

export interface KernelFetchOptions {
  method?: string;
  body?: unknown;
  /** Extra headers (e.g. a forwarded caller credential). */
  headers?: Record<string, string>;
}

export function kernelBaseUrl(): string | null {
  const url = process.env.IMAJIN_KERNEL_URL ?? process.env.IMAJIN_AUTH_URL;
  if (!url) return null;
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

export type KernelService = 'auth' | 'connections' | 'profile' | 'pay' | 'chat' | 'notify';

/**
 * Base URL of a kernel-hosted service. A per-service override
 * (`AUTH_SERVICE_URL`, `PAY_SERVICE_URL`, ...) wins; otherwise the service is
 * the kernel's path-prefixed route group (`${IMAJIN_KERNEL_URL}/pay`). Null
 * when neither is configured — callers treat that as "service not configured".
 */
export function serviceUrl(service: KernelService): string | null {
  const explicit = process.env[`${service.toUpperCase()}_SERVICE_URL`];
  if (explicit) return explicit;
  const base = kernelBaseUrl();
  return base ? `${base}/${service}` : null;
}

/** Browser-facing base URL of a kernel service (for links in emails / redirects). */
export function publicServiceUrl(service: KernelService): string {
  const base = process.env.NEXT_PUBLIC_IMAJIN_AUTH_URL ?? process.env.IMAJIN_AUTH_URL ?? '';
  return `${base}/${service}`;
}

/** This app's registration credentials as kernel app-auth headers. */
export function appAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const appDid = process.env.IMAJIN_APP_DID;
  const attestationId = process.env.IMAJIN_APP_ATTESTATION_ID;
  if (appDid) headers['X-App-DID'] = appDid;
  if (attestationId) headers['X-App-Authorization'] = attestationId;
  return headers;
}

/**
 * Fetch a kernel route (`path` starts with `/`, e.g. `/profile/api/resolve`).
 * Resolves to the parsed JSON body, or `null` on any non-2xx / network error.
 */
export async function kernelFetch<T>(path: string, options: KernelFetchOptions = {}): Promise<T | null> {
  const base = kernelBaseUrl();
  if (!base) {
    log.warn({ path }, 'IMAJIN_KERNEL_URL not set — skipping kernel call');
    return null;
  }

  try {
    const hasBody = options.body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...appAuthHeaders(),
        ...options.headers,
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      log.warn({ path, status: res.status }, 'Kernel call returned non-2xx');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn({ path, err: String(err) }, 'Kernel call failed');
    return null;
  }
}

/** Narrow transport for scoped app reads/private delivery, not a global credential. */
async function scopedAppFetch<T>(
  service: KernelService,
  path: string,
  body?: unknown,
  refreshOnce = false,
  orderId?: string,
): Promise<T | null> {
  const base = serviceUrl(service);
  if (!base) return null;
  const context = orderId ? { service, orderId } : { service };
  try {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const send = async () => fetch(`${base}${path}`, {
      method: serialized === undefined ? 'GET' : 'POST',
      headers: {
        ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${await getPayAppToken()}`,
      },
      body: serialized,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    let response = await send();
    if (response.status === 401) {
      await invalidatePayAppToken();
      if (refreshOnce) response = await send();
    }
    if (!response.ok) {
      if (response.status === 429 && orderId) {
        log.warn(
          { ...context, status: 429, retryAfter: response.headers.get('Retry-After') },
          'Private onboarding rate limited (claim retained; no retry)',
        );
      } else {
        log.warn({ ...context, status: response.status }, 'Scoped kernel call refused');
      }
      return null;
    }
    return await response.json() as T;
  } catch {
    log.warn(context, 'Scoped kernel call unavailable');
    return null;
  }
}

// ─── Profiles / identities ────────────────────────────────────────────────

export interface ResolvedProfile {
  did: string;
  handle: string | null;
  displayName: string | null;
  /** Only present when the kernel grants this app email visibility (service scope). */
  email?: string;
}

const MAX_RESOLVE_BATCH = 200;

/**
 * Batched DID → profile lookup via `POST /profile/api/resolve`. Handle and
 * display name are public; `email` is only returned when the kernel grants
 * this app the approved email scope AND a qualifying per-person relationship.
 */
export async function resolveProfiles(dids: string[]): Promise<Map<string, ResolvedProfile>> {
  const result = new Map<string, ResolvedProfile>();
  const unique = Array.from(new Set(dids.filter(Boolean)));

  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += MAX_RESOLVE_BATCH) {
    batches.push(unique.slice(i, i + MAX_RESOLVE_BATCH));
  }
  const responses = await Promise.all(
    batches.map((dids) =>
      scopedAppFetch<{ results?: ResolvedProfile[] }>('profile', '/api/resolve', { dids }, true)
    )
  );
  for (const data of responses) {
    if (!Array.isArray(data?.results)) continue;
    for (const entry of data.results) {
      if (entry?.did) result.set(entry.did, entry);
    }
  }
  return result;
}

/** Contact email for a DID, or null when unknown / not visible to this app. */
export async function getContactEmail(did: string): Promise<string | null> {
  const profiles = await resolveProfiles([did]);
  return profiles.get(did)?.email ?? null;
}

/** Identity tier for a DID via the public registry resolver (`soft` for unclaimed stubs). */
export async function getIdentityTier(did: string): Promise<string | null> {
  const data = await kernelFetch<{ tier?: string }>(
    `/registry/api/identity/${encodeURIComponent(did)}`
  );
  return data?.tier ?? null;
}

// ─── Pods (co-host membership) ────────────────────────────────────────────

export const ORGANIZER_POD_ROLES = ['owner', 'cohost'] as const;

interface PodMember {
  did: string;
  role: string;
  removedAt?: string | null;
}

/**
 * True when `did` is an active member of the pod with one of `roles`.
 *
 * Requires app scope and the pod owner's live OAuth grant. No cookie is forwarded.
 */
export function isPodMember(
  podId: string,
  did: string,
  roles?: readonly string[],
  callerCookie?: string | null,
): Promise<boolean>;
export async function isPodMember(
  podId: string,
  did: string,
  roles: readonly string[] = ORGANIZER_POD_ROLES,
): Promise<boolean> {
  const data = await scopedAppFetch<{ members?: PodMember[] }>(
    'connections', `/api/apps/pods/${encodeURIComponent(podId)}/members`,
  );
  return Array.isArray(data?.members)
    && data.members.some((m) => m?.did === did && roles.includes(m.role) && !m.removedAt);
}

/** Active direct memberships of the explicit DID, filtered by pod-owner consent. */
export async function listMemberPodIds(did: string): Promise<string[]> {
  const data = await scopedAppFetch<{ podIds?: string[] }>(
    'connections', `/api/apps/pods?did=${encodeURIComponent(did)}`,
  );
  return Array.isArray(data?.podIds)
    ? data.podIds.filter((id): id is string => typeof id === 'string')
    : [];
}

// ─── Eligibility / contact backfill / onboarding ──────────────────────────
// gap(kernel): eligibility still lacks registered-app authority; contact and
// onboarding use the scoped public contracts below. See docs/KERNEL-GAPS.md.

/** Ask the kernel to (re)evaluate a DID's tier eligibility after check-in. */
export async function evaluateEligibility(did: string): Promise<{ upgraded?: boolean } | null> {
  return kernelFetch<{ upgraded?: boolean }>('/auth/api/eligibility/evaluate', {
    method: 'POST',
    body: { did },
  });
}

/** Backfill a DID's contact email (NULL-guarded server-side — never overwrites). */
export async function backfillContactEmail(did: string, email: string): Promise<boolean> {
  const result = await scopedAppFetch<{ did: string; contactEmail: null; backfilled: boolean }>(
    'auth', `/api/identity/${encodeURIComponent(did)}/contact`, { email }, true,
  );
  return result !== null;
}

/** Kernel-private email for an eligible confirmed hosted checkout; never returns a credential. */
export async function sendOrderOnboard(transactionId: string, orderId?: string): Promise<boolean> {
  if (!transactionId) return false;
  const result = await scopedAppFetch<{ status?: string }>(
    'auth', '/api/onboard/send', { transactionId }, true, orderId,
  );
  return result?.status === 'sent';
}

export interface OrderPayment {
  transactionId: string;
  sessionId: string;
  metadata: Record<string, string>;
}

const PAYMENT_METADATA_KEYS = ['orderId', 'order_id', 'eventId', 'event_id', 'service', 'type'];

function parseOrderPayment(value: unknown, requested: Set<string>): OrderPayment | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.transactionId !== 'string' || !row.transactionId
    || typeof row.sessionId !== 'string' || !requested.has(row.sessionId)) return null;
  const metadata: Record<string, string> = {};
  if (row.metadata && typeof row.metadata === 'object') {
    const source = row.metadata as Record<string, unknown>;
    for (const key of PAYMENT_METADATA_KEYS) {
      const entry = source[key];
      if (typeof entry === 'string' && entry.length <= 200) metadata[key] = entry;
    }
  }
  return { transactionId: row.transactionId, sessionId: row.sessionId, metadata };
}

/** Best-effort descriptive payment enrichment, never proof of payment. */
export async function lookupOrderPayments(sellerDid: string, sessionIds: (string | null)[]): Promise<OrderPayment[]> {
  if (!sellerDid) return [];
  const unique = [...new Set(sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const payments: OrderPayment[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const data = await scopedAppFetch<{ transactions?: unknown[] }>(
      'pay', '/api/transactions/lookup', { sellerDid, sessionIds: batch },
    );
    if (!Array.isArray(data?.transactions)) return [];
    const requested = new Set(batch);
    for (const value of data.transactions) {
      const payment = parseOrderPayment(value, requested);
      if (payment) payments.push(payment);
    }
  }
  return payments;
}
