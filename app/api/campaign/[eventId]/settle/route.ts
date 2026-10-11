import { serviceUrl } from '@/lib/kernel';
/**
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
import { authenticateDid, findEvent, jsonError, pathEventId, createPreflight, rateLimitResponse } from '@/lib/campaign-route';
import { withLogger } from '@ima-jin/logger';

const PAY_SERVICE_URL = (serviceUrl('pay') ?? '');
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

export const OPTIONS = createPreflight();

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // Heavy rate limit — triggers real charges
  const limited = rateLimitResponse(request, 5, cors);
  if (limited) return limited;

  const did = await authenticateDid(request, cors);
  if (did instanceof NextResponse) return did;

  try {
    const eventId = pathEventId(request);
    if (!eventId) return jsonError('eventId is required', 400, cors);

    const event = await findEvent(eventId);
    if (!event) return jsonError('Event not found', 404, cors);

    if (event.eventType !== 'campaign') return jsonError('Not a campaign event', 400, cors);

    if (event.creatorDid !== did) return jsonError('Only the campaign creator can settle', 403, cors);

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
    log.error({ err: String(error) }, 'Campaign settle error');
    return NextResponse.json(
      { error: 'Failed to settle campaign' },
      { status: 500, headers: cors }
    );
  }
});
