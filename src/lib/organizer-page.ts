import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { requireAdmin, requireAuth, requireHardDID, resolveActingDid } from '@/lib/auth';
import { ServiceError } from '@/services/errors';
import { isEventOrganizer } from '@/services/authorization';
import { getEventWithTicketTypes } from '@/services/events-service';

type PageAccess = 'session' | 'admin' | 'create';

/** Use the same credential and authorization contract as the app's routes. */
export async function requirePageActor(access: PageAccess = 'session') {
  const incoming = await headers();
  const request = new Request(new URL('/dashboard', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'), {
    method: access === 'create' ? 'POST' : 'GET',
    headers: incoming,
  });
  let result;
  if (access === 'admin') {
    result = await requireAdmin(request);
  } else if (access === 'create') {
    result = await requireHardDID(request);
  } else {
    result = await requireAuth(request);
  }
  if ('error' in result) notFound();
  return { did: resolveActingDid(result.identity), cookie: incoming.get('cookie') };
}

/** Gate before reading organizer-only fields, including hidden ticket tiers. */
export async function loadOrganizerPage(eventId: string) {
  const actor = await requirePageActor();
  const organizer = await isEventOrganizer(eventId, actor.did, actor.cookie);
  if (!organizer.authorized) notFound();
  try {
    const data = await getEventWithTicketTypes(eventId, 'public');
    return { ...data, isCreator: organizer.role === 'creator' };
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'not_found') notFound();
    throw error;
  }
}
