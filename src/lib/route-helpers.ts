import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAppAuth } from '@ima-jin/auth';
import { db, ticketTypes } from '@/db';
import { requireAuth, resolveActingDid, type EventsIdentity } from '@/lib/auth';
import { isEventOrganizer } from '@/lib/organizer';

/** Route context for `/…/[id]/…` handlers. */
export type IdParams = { params: Promise<{ id: string }> };
/** Route context for `/…/[id]/tickets/[ticketId]/…` handlers. */
export type TicketParams = { params: Promise<{ id: string; ticketId: string }> };

export interface ActingCaller {
  /** The DID the request acts as (verified act-as / delegation, else the caller). */
  did: string;
  identity: EventsIdentity;
}

/**
 * Authenticate via scoped app token or session cookie (`requireSessionOrAppToken`).
 * Resolves to the acting caller, or the ready-to-return 401/403 response.
 */
export async function authenticateActing(
  request: Request,
  cors?: HeadersInit
): Promise<ActingCaller | NextResponse> {
  const result = await requireAuth(request);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
  }
  return { did: resolveActingDid(result.identity), identity: result.identity };
}

/**
 * Third-party apps authenticate with `X-App-DID` + a scoped token (`requireAppAuth`);
 * everyone else goes through {@link authenticateActing}.
 */
export async function authenticateAppOrActing(
  request: Request,
  scope: 'events:read' | 'events:write',
  cors?: HeadersInit
): Promise<{ did: string } | NextResponse> {
  if (!request.headers.get('x-app-did')) {
    return authenticateActing(request, cors);
  }
  const appResult = await requireAppAuth(request, { scope });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }
  return { did: appResult.appAuth.userDid };
}

/** `null` when `did` organizes the event (creator or cohost), else the 403 response to return. */
export async function forbidUnlessOrganizer(
  eventId: string,
  did: string,
  request: Request,
  message: string,
  cors?: HeadersInit
): Promise<NextResponse | null> {
  const check = await isEventOrganizer(eventId, did, request);
  if (check.authorized) return null;
  return NextResponse.json({ error: message }, { status: 403, headers: cors });
}

/**
 * Load a ticket type that belongs to `eventId`, or the ready-to-return 400/404
 * response when `ticketTypeId` is missing or does not match.
 */
export async function loadEventTicketType(
  ticketTypeId: string | null | undefined,
  eventId: string
): Promise<typeof ticketTypes.$inferSelect | NextResponse> {
  if (!ticketTypeId) {
    return NextResponse.json({ error: 'ticketTypeId is required' }, { status: 400 });
  }
  const [ticketType] = await db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
    .limit(1);
  if (!ticketType) {
    return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
  }
  return ticketType;
}
