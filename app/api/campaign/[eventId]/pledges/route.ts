/**
 * GET /api/campaign/{eventId}/pledges
 *
 * Returns all pledges for a campaign event.
 * Requires campaign creator auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, pledges } from '@/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { authenticateDid, findEvent, jsonError, pathEventId, preflight } from '@/lib/campaign-route';
import { withLogger } from '@ima-jin/logger';

export const OPTIONS = preflight;

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const did = await authenticateDid(request, cors);
  if (did instanceof NextResponse) return did;

  try {
    const eventId = pathEventId(request);
    if (!eventId) return jsonError('eventId is required', 400, cors);

    const event = await findEvent(eventId);
    if (!event) return jsonError('Event not found', 404, cors);

    if (event.creatorDid !== did) return jsonError('Only the campaign creator can view pledges', 403, cors);

    const pledgeList = await db
      .select()
      .from(pledges)
      .where(eq(pledges.eventId, eventId))
      .orderBy(pledges.createdAt);

    return NextResponse.json({ pledges: pledgeList }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign pledges error');
    return NextResponse.json(
      { error: 'Failed to get pledges' },
      { status: 500, headers: cors }
    );
  }
});
