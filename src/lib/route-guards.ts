import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid, type EventsIdentity } from '@/lib/auth';
import { isEventOrganizer } from '@/lib/organizer';

export interface Actor {
  /** The DID the request acts as (after act-as / delegation resolution). */
  did: string;
  identity: EventsIdentity;
}

/** Authenticate the caller; resolves to the acting DID + identity, or the error response to return as-is. */
export async function requireActor(request: NextRequest): Promise<Actor | NextResponse> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  return { did: resolveActingDid(authResult.identity), identity: authResult.identity };
}

/**
 * Require `did` to organize the event (creator or co-host). Resolves to the 403 response to
 * return, or null when authorized. `message` is the kernel route's own wording.
 */
export async function denyUnlessOrganizer(
  request: NextRequest,
  eventId: string,
  did: string,
  message = 'Forbidden',
): Promise<NextResponse | null> {
  const check = await isEventOrganizer(eventId, did, request);
  return check.authorized ? null : NextResponse.json({ error: message }, { status: 403 });
}
