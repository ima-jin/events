import { serviceUrl } from '@/lib/kernel';
﻿/**
 * POST /api/campaign/{eventId}/settle
 *
 * Charge all confirmed pledges for a campaign.
 * Requires campaign creator auth.
 *
 * Request: { eventId: string } (from URL)
 *
 * Response:
 * {
 *   charged: number,
 *   failed: number,
 *   total: number,
 *   results: Array<{ pledgeId: string, status: string, error?: string }>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, pledges } from '@/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { withLogger } from '@ima-jin/logger';
import { limitRequests, loadCampaignEvent, pathEventId, campaignFailure } from '@/lib/campaign-route';
import { authenticateActing } from '@/lib/route-helpers';

const PAY_SERVICE_URL = (serviceUrl('pay') ?? '');
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

export { campaignOptions as OPTIONS } from '@/lib/campaign-route';

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const limited = limitRequests(request, cors, 5);
  if (limited) return limited;

  const auth = await authenticateActing(request, cors);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;

  try {
    const event = await loadCampaignEvent(pathEventId(request), cors, { creator: { did, forbiddenMessage: 'Only the campaign creator can settle' } });
    if (event instanceof NextResponse) return event;
    const eventId = event.id;

    // Get all confirmed pledges
    const confirmedPledges = await db
      .select()
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          eq(pledges.status, 'confirmed')
        )
      );

    if (confirmedPledges.length === 0) {
      return NextResponse.json(
        { charged: 0, failed: 0, total: 0, results: [] },
        { headers: cors }
      );
    }

    // Check if target is met
    const totalPledged = confirmedPledges.reduce((sum, p) => sum + p.amount, 0);
    if (event.targetAmount && totalPledged < event.targetAmount) {
      return NextResponse.json(
        { error: 'Campaign target has not been met' },
        { status: 400, headers: cors }
      );
    }

    // Call pay service to charge pledges
    const payRes = await fetch(`${PAY_SERVICE_URL}/api/charge-pledges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
      },
      body: JSON.stringify({
        eventId,
        pledges: confirmedPledges.map((p) => ({
          pledgeId: p.id,
          amount: p.amount,
          currency: p.currency,
          stripeCustomerId: p.stripeCustomerId,
          stripePaymentMethodId: p.stripePaymentMethodId,
        })),
      }),
    });

    if (!payRes.ok) {
      const err = await payRes.json().catch(() => ({}));
      log.error({ err: err.error || payRes.statusText }, 'Pay service charge-pledges failed');
      return NextResponse.json(
        { error: err.error || 'Failed to charge pledges' },
        { status: 500, headers: cors }
      );
    }

    const chargeResult = await payRes.json();

    // Update pledge statuses based on results
    await Promise.all(
      (chargeResult.results || []).map((result: { status: string; pledgeId: string; error?: string }) => {
        const update =
          result.status === 'charged'
            ? { status: 'charged', chargedAt: new Date() }
            : { status: 'failed', failureReason: result.error || 'Charge failed' };
        return db.update(pledges).set(update).where(eq(pledges.id, result.pledgeId));
      })
    );

    return NextResponse.json(chargeResult, { headers: cors });
  } catch (error) {
    return campaignFailure(log, error, 'Campaign settle error', 'Failed to settle campaign', cors);
  }
});
