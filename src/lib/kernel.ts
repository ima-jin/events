import { createLogger } from '@ima-jin/logger';

/**
 * Public kernel API client — the ONLY way this app reads or writes anything
 * the kernel owns (identities, profiles, pods, onboarding, surveys, payments,
 * chat). The kernel's Postgres schemas are never touched directly; see
 * docs/MIGRATIONS.md.
 *
 * Calls authenticate with this app's registration credentials:
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

function kernelBaseUrl(): string | null {
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
 * this caller service scope (gap(kernel): registered-app email scope).
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
      kernelFetch<{ results?: ResolvedProfile[] }>('/profile/api/resolve', { method: 'POST', body: { dids } })
    )
  );
  for (const data of responses) {
    for (const entry of data?.results ?? []) {
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
 * gap(kernel): `GET /connections/api/pods/{id}` is session-authenticated, so
 * this only resolves when the caller's own cookie can be forwarded. An
 * app-token-only caller fails closed (not an organizer) until the kernel
 * exposes an app-auth pod-membership route. See docs/KERNEL-GAPS.md.
 */
export async function isPodMember(
  podId: string,
  did: string,
  roles: readonly string[] = ORGANIZER_POD_ROLES,
  callerCookie?: string | null
): Promise<boolean> {
  const data = await kernelFetch<{ members?: PodMember[] }>(
    `/connections/api/pods/${encodeURIComponent(podId)}`,
    { headers: callerCookie ? { Cookie: callerCookie } : undefined }
  );
  return (data?.members ?? []).some((m) => m.did === did && roles.includes(m.role) && !m.removedAt);
}

/**
 * Pod ids the caller belongs to (`GET /connections/api/pods`, caller-scoped).
 * gap(kernel): there is no route for "pods DID X belongs to" for a third
 * party, so this returns [] unless `callerCookie` belongs to `did` itself.
 */
export async function listMemberPodIds(callerCookie?: string | null): Promise<string[]> {
  if (!callerCookie) return [];
  const data = await kernelFetch<{ pods?: { id: string }[] }>('/connections/api/pods', {
    headers: { Cookie: callerCookie },
  });
  return (data?.pods ?? []).map((pod) => pod.id);
}

// ─── Eligibility / contact backfill / onboarding ──────────────────────────
// gap(kernel): these are gated by a kernel-internal API key today, so a
// registered app may be refused. They are best-effort in the kernel version
// too; here they call the documented route and degrade to a no-op when the
// kernel refuses. See docs/KERNEL-GAPS.md.

/** Ask the kernel to (re)evaluate a DID's tier eligibility after check-in. */
export async function evaluateEligibility(did: string): Promise<{ upgraded?: boolean } | null> {
  return kernelFetch<{ upgraded?: boolean }>('/auth/api/eligibility/evaluate', {
    method: 'POST',
    body: { did },
  });
}

/** Backfill a DID's contact email (NULL-guarded server-side — never overwrites). */
export async function backfillContactEmail(did: string, email: string): Promise<boolean> {
  const result = await kernelFetch<{ ok?: boolean }>(
    `/auth/api/identity/${encodeURIComponent(did)}/contact`,
    { method: 'POST', body: { email } }
  );
  return result !== null;
}

/**
 * Mint a magic-link onboard token to embed in a buyer's ticket email.
 *
 * gap(kernel): the kernel version inserted a row into `auth.onboard_tokens`
 * directly. The public `POST /auth/api/onboard` is NOT a substitute — it
 * sends its own verification email and returns no token — so there is no
 * public way for a registered app to mint one. Always resolves to null; every
 * caller already treats a missing token as non-fatal (the email is sent
 * without the magic link). See docs/KERNEL-GAPS.md.
 */
export function createOnboardToken(): Promise<string | null> {
  return Promise.resolve(null);
}
