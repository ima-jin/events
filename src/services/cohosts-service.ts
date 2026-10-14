import {
  createEventPod,
  fetchPodMembers,
  mutatePodMember,
  resolveCoHostDid,
  resolveProfileByDid,
  syncCohostToChat,
  validCohostDid,
  type CoHostProfileData,
} from '@/lib/cohost-helpers';
import { attachEventPodIfMissing, getEventById, type EventRow } from '@/repositories/events-repository';
import { createLogger } from '@ima-jin/logger';
import { isEventOrganizer } from '@/services/authorization';
import { ServiceError } from '@/services/errors';

const log = createLogger('events');

async function requireEvent(eventId: string): Promise<EventRow> {
  const event = await getEventById(eventId);
  if (!event) throw new ServiceError('not_found', 'Event not found');
  return event;
}

async function requireCreator(eventId: string, actorDid: string, action: 'add' | 'remove'): Promise<EventRow> {
  const event = await requireEvent(eventId);
  if (event.creatorDid !== actorDid) {
    throw new ServiceError('forbidden', `Only the event owner can ${action} cohosts`);
  }
  return event;
}

function requirePod(event: EventRow): string {
  if (!event.podId?.trim()) {
    throw new ServiceError('unavailable', 'Event pod not initialized', { status: 500 });
  }
  return event.podId;
}

async function ensureEventPod(event: EventRow, cookie: string): Promise<string> {
  if (event.podId !== null) return requirePod(event);
  const createdPodId = await createEventPod(event.title, cookie);
  const attached = await attachEventPodIfMissing(event.id, createdPodId);
  if (!attached) throw new ServiceError('not_found', 'Event not found');
  const podId = requirePod(attached);
  if (podId !== createdPodId) {
    log.warn({ eventId: event.id, unusedPodId: createdPodId }, 'Concurrent pod initialization used the winning event pod');
  }
  return podId;
}

function targetBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ServiceError('invalid', 'Body must be an object');
  }
  return body as Record<string, unknown>;
}

function rejectProtectedTarget(did: string, actorDid: string, creatorDid: string, action: 'add' | 'remove'): void {
  if (did === actorDid) throw new ServiceError('invalid', `Cannot ${action} yourself as cohost`);
  if (did === creatorDid) throw new ServiceError('invalid', 'Event creator is already the owner');
}

function cohostEntry(did: string, profile: CoHostProfileData, addedAt: string, handle?: string) {
  return {
    did,
    name: profile.name || null,
    handle: profile.handle || handle || null,
    avatar: profile.avatarUrl || profile.avatar || null,
    role: 'cohost',
    addedAt,
  };
}

/** Organizer-only listing. Profile failures remain non-fatal; membership errors are actionable. */
export async function listEventCohosts(eventId: string, actorDid: string, cookie = '') {
  const event = await requireEvent(eventId);
  const check = await isEventOrganizer(eventId, actorDid, cookie);
  if (!check.authorized) throw new ServiceError('forbidden', 'Forbidden');
  if (!event.podId) return { cohosts: [] };
  const members = (await fetchPodMembers(requirePod(event), cookie))
    .filter((member) => member.role === 'cohost')
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
  const cohosts = await Promise.all(members.map(async (member) =>
    cohostEntry(member.did, await resolveProfileByDid(member.did), member.joinedAt),
  ));
  return { cohosts };
}

/** Creator-only add, retaining handle resolution and repeat-add idempotence. */
export async function addEventCohost(eventId: string, actorDid: string, body: unknown, cookie = '') {
  const event = await requireCreator(eventId, actorDid, 'add');
  const input = targetBody(body);
  const target = await resolveCoHostDid(input.did, input.handle);
  if ('error' in target) {
    throw new ServiceError('invalid', target.error, { status: target.status });
  }
  rejectProtectedTarget(target.coHostDid, actorDid, event.creatorDid, 'add');
  const podId = await ensureEventPod(event, cookie);
  const members = await fetchPodMembers(podId, cookie);
  const existing = members.find((member) => member.did === target.coHostDid);
  let addedAt: string;
  if (existing) {
    addedAt = existing.joinedAt;
  } else {
    const result = await mutatePodMember(podId, target.coHostDid, cookie, 'POST');
    if (typeof result.member?.joinedAt !== 'string') {
      throw new ServiceError('unavailable', 'Invalid connections member response', { status: 502 });
    }
    addedAt = result.member.joinedAt;
  }
  await syncCohostToChat(target.coHostDid, event.did, cookie);
  const handle = typeof input.handle === 'string' ? input.handle.trim().replace(/^@/, '') : undefined;
  return { cohost: cohostEntry(target.coHostDid, target.profileData, addedAt, handle) };
}

/** Creator-only removal, never removing another role or a missing/removed member. */
export async function removeEventCohost(eventId: string, actorDid: string, body: unknown, cookie = '') {
  const event = await requireCreator(eventId, actorDid, 'remove');
  const podId = requirePod(event);
  const { did } = targetBody(body);
  if (!validCohostDid(did)) throw new ServiceError('invalid', 'A valid did is required');
  rejectProtectedTarget(did, actorDid, event.creatorDid, 'remove');
  const members = await fetchPodMembers(podId, cookie);
  const hasTarget = members.some((member) => member.did === did && member.role === 'cohost');
  if (!hasTarget) throw new ServiceError('not_found', 'Cohost not found');
  const result = await mutatePodMember(podId, did, cookie, 'DELETE');
  if (result.removed !== true) {
    throw new ServiceError('unavailable', 'Invalid connections removal response', { status: 502 });
  }
  return { removed: true };
}
