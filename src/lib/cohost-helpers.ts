import { serviceUrl } from '@/lib/kernel';
import { createLogger } from '@ima-jin/logger';
import { ServiceError, isServiceError } from '@/services/errors';
/**
 * Helpers for cohost management routes.
 * Extracted from app/api/events/[id]/cohosts/route.ts to reduce cognitive complexity.
 */

const log = createLogger('events');

export function validCohostDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/.test(value);
}

export interface CoHostProfileData {
  name?: string;
  handle?: string;
  avatar?: string;
  avatarUrl?: string;
}

export type ResolveCoHostResult =
  | { error: string; status: number }
  | { coHostDid: string; profileData: CoHostProfileData };

/**
 * Resolve the cohost DID from either a direct DID parameter or a handle string.
 * Looks up the DID via the profile service when a handle is provided.
 */
export async function resolveCoHostDid(
  didParam: unknown,
  handle: unknown,
): Promise<ResolveCoHostResult> {
  if (didParam !== undefined && didParam !== null) {
    if (!validCohostDid(didParam)) return { error: 'A valid did is required', status: 400 };
    const profileData = await resolveProfileByDid(didParam);
    return { coHostDid: didParam, profileData };
  }
  if (!didParam && !handle) return { error: 'did or handle is required', status: 400 };

  if (typeof handle !== 'string') {
    return { error: 'handle must be a string', status: 400 };
  }
  const normalizedHandle = handle.trim().replace(/^@/, '');
  if (!normalizedHandle) return { error: 'handle must not be empty', status: 400 };
  return resolveProfileByHandle(normalizedHandle);
}

async function resolveProfileByHandle(handle: string): Promise<ResolveCoHostResult> {
  try {
    const res = await fetch(
      `${serviceUrl('profile') ?? ''}/api/profile/by-handle/${encodeURIComponent(handle)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) {
      const failure = await res.json().catch(() => ({}));
      return {
        error: typeof failure?.error === 'string' ? failure.error : 'Handle not found',
        status: res.status,
      };
    }
    const data = await res.json();
    const coHostDid: string = data.did;
    if (!validCohostDid(coHostDid)) {
      return { error: 'Could not resolve DID for handle', status: 404 };
    }
    return { coHostDid, profileData: data };
  } catch {
    return { error: 'Failed to look up handle', status: 502 };
  }
}

/** Resolve basic profile data (name/handle/avatar) for a known DID. */
export async function resolveProfileByDid(did: string): Promise<CoHostProfileData> {
  try {
    const res = await fetch(
      `${serviceUrl('auth') ?? ''}/api/lookup/${encodeURIComponent(did)}`,
      { cache: 'no-store' },
    );
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return {
        name: identity.name || undefined,
        handle: identity.handle || undefined,
        avatar: identity.avatar || identity.avatarUrl || undefined,
      };
    }
  } catch {
    log.warn({ did }, 'Cohost profile lookup failed (non-fatal)');
  }
  return {};
}

export interface PodMemberRow {
  did: string;
  role: string;
  joinedAt: string;
  removedAt?: string | null;
}

interface ConnectionsResult {
  members?: PodMemberRow[];
  member?: PodMemberRow;
  removed?: boolean;
  pod?: { id?: unknown };
}

async function connectionsRequest(path: string, options: RequestInit): Promise<ConnectionsResult> {
  const url = serviceUrl('connections');
  if (!url) throw new ServiceError('unavailable', 'Connections service is not configured', { status: 502 });
  try {
    const endpoint = path ? `/api/pods/${path}` : '/api/pods';
    const res = await fetch(`${url}${endpoint}`, options);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const error = typeof data?.error === 'string' ? data.error : 'Connections request failed';
      throw new ServiceError('unavailable', error, { status: res.status });
    }
    if (!data || typeof data !== 'object') {
      throw new ServiceError('unavailable', 'Invalid connections response', { status: 502 });
    }
    return data as ConnectionsResult;
  } catch (error) {
    if (isServiceError(error)) throw error;
    throw new ServiceError('unavailable', 'Failed to reach connections service', { status: 502 });
  }
}

/** Forward caller session; a failed membership read must never turn into a successful write. */
export async function fetchPodMembers(podId: string, cookie: string): Promise<PodMemberRow[]> {
  const data = await connectionsRequest(encodeURIComponent(podId), { headers: { cookie }, cache: 'no-store' });
  if (!Array.isArray(data.members)) {
    throw new ServiceError('unavailable', 'Invalid connections members response', { status: 502 });
  }
  return data.members.filter((member) => !member.removedAt);
}

/**
 * Both methods use the documented /api/pods/{id}/members JSON-body contract.
 * The kernel has no /members/{did} route (connections spec and route verified).
 */
export function mutatePodMember(podId: string, did: string, cookie: string, method: 'POST' | 'DELETE') {
  const body = method === 'POST' ? { did, role: 'cohost' } : { did };
  return connectionsRequest(`${encodeURIComponent(podId)}/members`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** Create through the public verified-identity/trust-graph-gated pod API. */
export async function createEventPod(title: string, cookie: string): Promise<string> {
  const data = await connectionsRequest('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: title, type: 'event', visibility: 'private' }),
  });
  if (typeof data.pod?.id !== 'string' || !data.pod.id.trim()) {
    throw new ServiceError('unavailable', 'Invalid connections pod response', { status: 502 });
  }
  return data.pod.id;
}

/** Chat enrollment is best effort and does not invalidate the pod membership change. */
export async function syncCohostToChat(coHostDid: string, eventDid: string | null, cookie: string): Promise<void> {
  const url = serviceUrl('chat');
  if (!url || !eventDid) return;
  try {
    const response = await fetch(`${url}/api/d/${encodeURIComponent(eventDid)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ memberDid: coHostDid, role: 'admin' }),
    });
    if (response.ok) {
      log.info({ coHostDid, eventDid }, 'Added cohost to event chat');
    } else {
      log.warn({ status: response.status }, 'Cohost chat sync failed (non-fatal)');
    }
  } catch (error) {
    log.warn({ err: String(error) }, 'Cohost chat sync failed (non-fatal)');
  }
}
