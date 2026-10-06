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

function appHeaders(): Record<string, string> {
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
        ...appHeaders(),
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

  for (let i = 0; i < unique.length; i += MAX_RESOLVE_BATCH) {
    const batch = unique.slice(i, i + MAX_RESOLVE_BATCH);
    const data = await kernelFetch<{ profiles?: ResolvedProfile[] } | ResolvedProfile[]>(
      '/profile/api/resolve',
      { method: 'POST', body: { dids: batch } }
    );
    const entries = Array.isArray(data) ? data : (data?.profiles ?? []);
    for (const entry of entries) {
      result.set(entry.did, entry);
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

/** True when `did` is an active owner/cohost of the pod. */
export async function isPodOrganizer(podId: string, did: string, callerCookie?: string | null): Promise<boolean> {
  const data = await kernelFetch<{
    members?: { did: string; role: string; removedAt?: string | null }[];
  }>(`/connections/api/pods/${encodeURIComponent(podId)}`, {
    headers: callerCookie ? { Cookie: callerCookie } : undefined,
  });
  return (data?.members ?? []).some(
    (m) => m.did === did && ['owner', 'cohost'].includes(m.role) && !m.removedAt
  );
}
