/**
 * GET /api/campaign/{eventId}/status
 *
 * Public endpoint — returns campaign funding status.
 *
 * Response:
 * {
 *   targetAmount: number,
 *   currentAmount: number,
 *   pledgeCount: number,
 *   deadline: string | null,
 *   percentFunded: number,
 *   isFullyFunded: boolean
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, pledges } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { withLogger } from '@ima-jin/logger';
import { loadCampaignEvent, pathEventId, campaignFailure } from '@/lib/campaign-route';

export { campaignOptions as OPTIONS } from '@/lib/campaign-route';

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const event = await loadCampaignEvent(pathEventId(request), cors);
    if (event instanceof NextResponse) return event;
    const eventId = event.id;

    // Sum confirmed + charged pledges
    const pledgeRows = await db
      .select({
        totalAmount: sql<number>`COALESCE(SUM(${pledges.amount}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          sql`${pledges.status} IN ('confirmed', 'charged')`
        )
      );

    const currentAmount = pledgeRows[0]?.totalAmount ?? 0;
    const pledgeCount = pledgeRows[0]?.count ?? 0;
    const targetAmount = event.targetAmount ?? 0;

    const percentFunded = targetAmount > 0
      ? Math.min(100, Math.floor((currentAmount / targetAmount) * 100))
      : 0;

    return NextResponse.json({
      targetAmount,
      currentAmount,
      pledgeCount,
      deadline: event.deadline ? new Date(event.deadline).toISOString() : null,
      percentFunded,
      isFullyFunded: currentAmount >= targetAmount,
    }, { headers: cors });
  } catch (error) {
    return campaignFailure(log, error, 'Campaign status error', 'Failed to get campaign status', cors);
  }
});
