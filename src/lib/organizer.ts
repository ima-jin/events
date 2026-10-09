import { db, events } from '@/db';
import { eq } from 'drizzle-orm';
import { isPodMember } from '@/lib/kernel';

/**
 * Check if a DID is an organizer of an event.
 * An organizer is: the creator or a cohost (via the kernel's pod membership).
 *
 * Pass the incoming `request` so the caller's own session cookie can be
 * forwarded to the kernel's pod-membership route (see `isPodMember`).
 *
 * Returns { authorized: true, role } or { authorized: false }.
 */
export async function isEventOrganizer(
  eventId: string,
  did: string,
  request?: Request
): Promise<{ authorized: true; role: 'creator' | 'cohost' } | { authorized: false }> {
  const [event] = await db
    .select({ creatorDid: events.creatorDid, podId: events.podId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) return { authorized: false };

  if (event.creatorDid === did) {
    return { authorized: true, role: 'creator' };
  }

  if (event.podId && (await isPodMember(event.podId, did, undefined, request?.headers.get('cookie')))) {
    return { authorized: true, role: 'cohost' };
  }

  return { authorized: false };
}
