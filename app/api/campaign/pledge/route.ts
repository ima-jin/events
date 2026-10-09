import { serviceUrl } from '@/lib/kernel';
﻿/**
 * POST /api/campaign/pledge
 *
 * Create a pledge for a campaign event.
 * Calls the pay service to create a Stripe SetupIntent.
 *
 * Request:
 * {
 *   eventId: string,
 *   amount: number          // cents, min 100 = $1
 * }
 *
 * Response:
 * {
 *   pledgeId: string,
 *   clientSecret: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, pledges } from '@/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { withLogger } from '@ima-jin/logger';
import { limitRequests, loadCampaignEvent, campaignFailure } from '@/lib/campaign-route';
import { authenticateActing } from '@/lib/route-helpers';
import { randomBytes } from 'node:crypto';

const PAY_SERVICE_URL = (serviceUrl('pay') ?? '');

export { campaignOptions as OPTIONS } from '@/lib/campaign-route';

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const limited = limitRequests(request, cors, 10);
  if (limited) return limited;

  const auth = await authenticateActing(request, cors);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;

  try {
    const body = await request.json();
    const { eventId, amount } = body;

    if (!eventId || typeof eventId !== 'string') {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400, headers: cors });
    }

    if (typeof amount !== 'number' || amount < 100 || !Number.isInteger(amount)) {
      return NextResponse.json(
        { error: 'amount must be an integer >= 100 (minimum $1.00)' },
        { status: 400, headers: cors }
      );
    }

    // Fetch and validate event
    const event = await loadCampaignEvent(eventId, cors);
    if (event instanceof NextResponse) return event;

    if (event.status !== 'published') {
      return NextResponse.json(
        { error: 'Campaign is not available for pledging' },
        { status: 400, headers: cors }
      );
    }

    if (event.deadline && new Date(event.deadline) < new Date()) {
      return NextResponse.json(
        { error: 'Campaign deadline has passed' },
        { status: 400, headers: cors }
      );
    }

    // Check for existing pledge from this backer
    const [existingPledge] = await db
      .select()
      .from(pledges)
      .where(and(eq(pledges.eventId, eventId), eq(pledges.backerDid, did)))
      .limit(1);

    if (existingPledge && ['confirmed', 'charged'].includes(existingPledge.status)) {
      return NextResponse.json(
        { error: 'You already have an active pledge for this campaign' },
        { status: 409, headers: cors }
      );
    }

    // Call pay service to create SetupIntent
    const payRes = await fetch(`${PAY_SERVICE_URL}/api/setup-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: request.headers.get('cookie') || '',
      },
      body: JSON.stringify({
        amount,
        currency: 'CAD',
        metadata: { eventId, backerDid: did },
      }),
    });

    if (!payRes.ok) {
      const err = await payRes.json().catch(() => ({}));
      log.error({ err: err.error || payRes.statusText }, 'Pay service SetupIntent failed');
      return NextResponse.json(
        { error: err.error || 'Failed to create payment setup' },
        { status: 500, headers: cors }
      );
    }

    const { clientSecret, setupIntentId, customerId } = await payRes.json();

    // Create or update pledge record
    const pledgeId = existingPledge?.id || `plg_${randomBytes(12).toString('hex')}`;

    if (existingPledge) {
      await db
        .update(pledges)
        .set({
          amount,
          stripeSetupIntentId: setupIntentId,
          stripeCustomerId: customerId,
          status: 'pending',
          metadata: { ...(existingPledge.metadata as Record<string, unknown>), updatedAt: new Date().toISOString() },
        })
        .where(eq(pledges.id, existingPledge.id));
    } else {
      await db.insert(pledges).values({
        id: pledgeId,
        eventId,
        backerDid: did,
        amount,
        currency: 'CAD',
        stripeSetupIntentId: setupIntentId,
        stripeCustomerId: customerId,
        status: 'pending',
        metadata: {},
      });
    }

    return NextResponse.json(
      { pledgeId, clientSecret },
      { headers: cors }
    );
  } catch (error) {
    return campaignFailure(log, error, 'Campaign pledge error', 'Failed to create pledge', cors);
  }
});