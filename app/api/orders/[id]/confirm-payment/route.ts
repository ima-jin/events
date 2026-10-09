/**
 * POST /api/orders/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for an order atomically.
 * Changes all held tickets in the order from 'held' to 'valid'.
 * Requires event organizer auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { isServiceError } from '@/services/errors';
import { confirmOrderPayment } from '@/services/order-confirmation';

const log = createLogger('events');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const actorDid = resolveActingDid(authResult.identity);
  const { id: orderId } = await params;

  try {
    const result = await confirmOrderPayment(orderId, {
      actorDid,
      callerCookie: request.headers.get('cookie'),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Order confirm-payment error');
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 });
  }
}
