import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createLogger } from '@ima-jin/logger';
import { requireAppAuth } from '@ima-jin/auth';
import { corsHeaders } from '@ima-jin/config';
import { authenticateAppOrSession } from '@/lib/app-or-session';
import { failureResponse } from '@/lib/events-route-response';
import type { EventUpdateBody } from '@/lib/event-update-helpers';
import { getEventWithTicketTypes, updateEvent, updateEventStatus } from '@/services/events-service';

const log = createLogger('events');

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/events/[id] - Get event details with ticket types
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const cors = corsHeaders(request);
  const isAppCall = Boolean(request.headers.get('x-app-did'));
  // CORS headers are only sent on the legacy registered-app path (kernel behaviour).
  const headers = isAppCall ? cors : undefined;

  if (isAppCall) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
  }

  try {
    const { id } = await params;
    const result = await getEventWithTicketTypes(id, isAppCall ? 'app' : 'public');
    return NextResponse.json(result, { headers });
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to get event', log, logFields: { appAuth: isAppCall }, headers });
  }
}

/**
 * PATCH /api/events/[id] - Update event status (requires auth as creator only)
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const caller = await authenticateAppOrSession(request, corsHeaders(request), { appScope: 'events:write' });
  if (caller instanceof NextResponse) return caller;

  const { id } = await params;

  try {
    const { status } = await request.json();
    const event = await updateEventStatus({ eventId: id, actorDid: caller.did, status });

    revalidatePath(`/${id}`);
    revalidatePath('/');

    return NextResponse.json({ event });
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to update event status', log });
  }
}

/**
 * PUT /api/events/[id] - Update event (requires auth as creator or co-host)
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const caller = await authenticateAppOrSession(request, corsHeaders(request), { appScope: 'events:write' });
  if (caller instanceof NextResponse) return caller;

  const { id } = await params;

  try {
    const body = (await request.json()) as EventUpdateBody;
    const event = await updateEvent({
      eventId: id,
      actorDid: caller.did,
      body,
      callerCookie: request.headers.get('cookie'),
    });

    // Bust the cache for this event page
    revalidatePath(`/${id}`);

    return NextResponse.json({ event });
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to update event', log });
  }
}
