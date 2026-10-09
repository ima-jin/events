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
import { findEvent, jsonError, pathEventId, preflight } from '@/lib/campaign-route';
import { withLogger } from '@ima-jin/logger';

export const OPTIONS = preflight;

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const eventId = pathEventId(request);
    if (!eventId) return jsonError('eventId is required', 400, cors);

    const event = await findEvent(eventId);
    if (!event) return jsonError('Event not found', 404, cors);

    if (event.eventType !== 'campaign') return jsonError('Not a campaign event', 400, cors);

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
    log.error({ err: String(error) }, 'Campaign status error');
    return NextResponse.json(
      { error: 'Failed to get campaign status' },
      { status: 500, headers: cors }
    );
  }
});
