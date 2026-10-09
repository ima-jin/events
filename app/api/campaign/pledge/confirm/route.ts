/**
 * POST /api/campaign/pledge/confirm
 *
 * Confirm a pledge after Stripe.js successfully confirms the SetupIntent.
 * Verifies the SetupIntent status and updates the pledge record.
 *
 * Request:
 * {
 *   pledgeId: string,
 *   setupIntentId: string
 * }
 *
 * Response:
 * {
 *   success: true,
 *   pledge: { id: string, amount: number, status: string }
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, pledges } from '@/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { authenticateDid, createPreflight, rateLimitResponse } from '@/lib/campaign-route';
import { withLogger } from '@ima-jin/logger';

export const OPTIONS = createPreflight();

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const limited = rateLimitResponse(request, 20, cors);
  if (limited) return limited;

  const did = await authenticateDid(request, cors);
  if (did instanceof NextResponse) return did;

  try {
    const body = await request.json();
    const { pledgeId, setupIntentId, paymentMethodId } = body;

    if (!pledgeId || typeof pledgeId !== 'string') {
      return NextResponse.json({ error: 'pledgeId is required' }, { status: 400, headers: cors });
    }

    if (!setupIntentId || typeof setupIntentId !== 'string') {
      return NextResponse.json({ error: 'setupIntentId is required' }, { status: 400, headers: cors });
    }

    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      return NextResponse.json({ error: 'paymentMethodId is required' }, { status: 400, headers: cors });
    }

    // Find the pledge
    const [pledge] = await db
      .select()
      .from(pledges)
      .where(and(eq(pledges.id, pledgeId), eq(pledges.backerDid, did)))
      .limit(1);

    if (!pledge) {
      return NextResponse.json({ error: 'Pledge not found' }, { status: 404, headers: cors });
    }

    if (pledge.stripeSetupIntentId !== setupIntentId) {
      return NextResponse.json(
        { error: 'SetupIntent ID mismatch' },
        { status: 400, headers: cors }
      );
    }

    // Update pledge to confirmed
    await db
      .update(pledges)
      .set({
        status: 'confirmed',
        stripePaymentMethodId: paymentMethodId,
        metadata: {
          ...(pledge.metadata as Record<string, unknown>),
          confirmedAt: new Date().toISOString(),
        },
      })
      .where(eq(pledges.id, pledgeId));

    return NextResponse.json(
      {
        success: true,
        pledge: {
          id: pledge.id,
          amount: pledge.amount,
          status: 'confirmed',
        },
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign pledge confirm error');
    return NextResponse.json(
      { error: 'Failed to confirm pledge' },
      { status: 500, headers: cors }
    );
  }
});