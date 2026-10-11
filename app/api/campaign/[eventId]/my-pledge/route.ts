/**
 * GET /api/campaign/{eventId}/my-pledge
 *
 * Returns the current user's pledge for a campaign, if any.
 * Requires auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, pledges } from '@/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { authenticateDid, jsonError, pathEventId, createPreflight } from '@/lib/campaign-route';
import { withLogger } from '@ima-jin/logger';

export const OPTIONS = createPreflight();

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const did = await authenticateDid(request, cors);
  if (did instanceof NextResponse) return did;

  try {
    const eventId = pathEventId(request);
    if (!eventId) return jsonError('eventId is required', 400, cors);

    const [pledge] = await db
      .select({
        id: pledges.id,
        amount: pledges.amount,
        status: pledges.status,
      })
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          eq(pledges.backerDid, did)
        )
      )
      .limit(1);

    return NextResponse.json({ pledge: pledge || null }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'My pledge error');
    return NextResponse.json(
      { error: 'Failed to get pledge' },
      { status: 500, headers: cors }
    );
  }
});
