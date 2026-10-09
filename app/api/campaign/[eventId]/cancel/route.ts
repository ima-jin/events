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
import { eq, and, sql, inArray } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { withLogger } from '@ima-jin/logger';
import { limitRequests, loadCampaignEvent, pathEventId, campaignFailure } from '@/lib/campaign-route';
import { authenticateActing } from '@/lib/route-helpers';

export { campaignOptions as OPTIONS } from '@/lib/campaign-route';

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const limited = limitRequests(request, cors, 10);
  if (limited) return limited;

  const auth = await authenticateActing(request, cors);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;

  try {
    const event = await loadCampaignEvent(pathEventId(request), cors, { creator: { did, forbiddenMessage: 'Only the campaign creator can cancel' } });
    if (event instanceof NextResponse) return event;
    const eventId = event.id;

    // Cancel all pending and confirmed pledges
    const cancelledPledges = await db
      .select({ id: pledges.id })
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          sql`${pledges.status} IN ('pending', 'confirmed')`
        )
      );

    if (cancelledPledges.length > 0) {
      await db
        .update(pledges)
        .set({ status: 'cancelled' })
        .where(inArray(pledges.id, cancelledPledges.map((p) => p.id)));
    }

    // Also mark the event as cancelled
    await db
      .update(events)
      .set({ status: 'cancelled' })
      .where(eq(events.id, eventId));

    const cancelledCount = cancelledPledges.length;

    return NextResponse.json({ cancelled: cancelledCount }, { headers: cors });
  } catch (error) {
    return campaignFailure(log, error, 'Campaign cancel error', 'Failed to cancel campaign', cors);
  }
});
