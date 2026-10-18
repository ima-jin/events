import { isPodMember } from '@/lib/kernel';
import { getEventOwnership } from '@/repositories/events-repository';

export type OrganizerCheck = { authorized: true; role: 'creator' | 'cohost' } | { authorized: false };

/**
 * Is `did` an organizer of the event? An organizer is the creator or a co-host
 * (an active member of the event's kernel pod, resolved through the kernel's
 * public pod API — never a kernel database).
 *
 * Membership reads use app authorization, operator-approved connections:read
 * scope and the pod owner's active grant. The optional `callerCookie` is
 * retained for compatibility only and ignored by `isPodMember`; missing app
 * entitlement or failed membership reads deny co-host access.
 */
export async function isEventOrganizer(
  eventId: string,
  did: string,
  callerCookie?: string | null,
): Promise<OrganizerCheck> {
  const ownership = await getEventOwnership(eventId);
  if (!ownership) return { authorized: false };

  if (ownership.creatorDid === did) {
    return { authorized: true, role: 'creator' };
  }

  if (ownership.podId && (await isPodMember(ownership.podId, did, undefined, callerCookie))) {
    return { authorized: true, role: 'cohost' };
  }

  return { authorized: false };
}
