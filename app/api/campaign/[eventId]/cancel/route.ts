/**
 * POST /api/campaign/{eventId}/cancel
 *
 * Cancel a campaign and all pending/confirmed pledges.
 * Requires campaign creator auth.
 *
 * Response:
 * {
 *   cancelled: number
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, pledges } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { authenticateDid, findEvent, jsonError, pathEventId, createPreflight, rateLimitResponse } from '@/lib/campaign-route';
import { withLogger } from '@ima-jin/logger';

export const OPTIONS = createPreflight();

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const limited = rateLimitResponse(request, 10, cors);
  if (limited) return limited;

  const did = await authenticateDid(request, cors);
  if (did instanceof NextResponse) return did;

  try {
    const eventId = pathEventId(request);
    if (!eventId) return jsonError('eventId is required', 400, cors);

    const event = await findEvent(eventId);
    if (!event) return jsonError('Event not found', 404, cors);

    if (event.eventType !== 'campaign') return jsonError('Not a campaign event', 400, cors);

    if (event.creatorDid !== did) return jsonError('Only the campaign creator can cancel', 403, cors);

    // Cancel all pending and confirmed pledges
    const cancelledPledges = await db
      .update(pledges)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(pledges.eventId, eventId),
          sql`${pledges.status} IN ('pending', 'confirmed')`
        )
      )
      .returning({ id: pledges.id });

    // Also mark the event as cancelled
    await db
      .update(events)
      .set({ status: 'cancelled' })
      .where(eq(events.id, eventId));

    const cancelledCount = cancelledPledges.length;

    return NextResponse.json({ cancelled: cancelledCount }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign cancel error');
    return NextResponse.json(
      { error: 'Failed to cancel campaign' },
      { status: 500, headers: cors }
    );
  }
});
