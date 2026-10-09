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
import { withLogger } from '@ima-jin/logger';
import { pathEventId, campaignFailure } from '@/lib/campaign-route';
import { authenticateActing } from '@/lib/route-helpers';

export { campaignOptions as OPTIONS } from '@/lib/campaign-route';

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const auth = await authenticateActing(request, cors);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;

  try {
    const eventId = pathEventId(request);

    if (!eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400, headers: cors });
    }

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
    return campaignFailure(log, error, 'My pledge error', 'Failed to get pledge', cors);
  }
});
