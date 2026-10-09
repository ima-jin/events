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
import { withLogger } from '@ima-jin/logger';
import { campaignOptions, loadCampaignEvent, pathEventId, campaignFailure } from '@/lib/campaign-route';
import { authenticateActing } from '@/lib/route-helpers';

export const OPTIONS = campaignOptions;

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const auth = await authenticateActing(request, cors);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;

  try {
    const event = await loadCampaignEvent(pathEventId(request), cors, { campaignOnly: false, creator: { did, forbiddenMessage: 'Only the campaign creator can view pledges' } });
    if (event instanceof NextResponse) return event;
    const eventId = event.id;

    const pledgeList = await db
      .select()
      .from(pledges)
      .where(eq(pledges.eventId, eventId))
      .orderBy(pledges.createdAt);

    return NextResponse.json({ pledges: pledgeList }, { headers: cors });
  } catch (error) {
    return campaignFailure(log, error, 'Campaign pledges error', 'Failed to get pledges', cors);
  }
});
