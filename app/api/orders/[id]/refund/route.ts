/**
 * POST /api/orders/[id]/refund
 *
 * Refunds an entire order atomically (organizer-only). All business rules
 * (Stripe vs free/e-transfer, ticket + order status, sold counters, the
 * `order.refunded` event) live in `refundOrder` (services/orders-service).
 *
 * This endpoint is designed for the "refund entire order" case. Per-ticket
 * partial refunds are handled by the individual ticket refund route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { isServiceError } from '@/services/errors';
import { refundOrder } from '@/services/orders-service';

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
    const result = await refundOrder({
      orderId,
      actorDid,
      callerCookie: request.headers.get('cookie'),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Order refund error');
    return NextResponse.json({ error: 'Failed to refund order' }, { status: 500 });
  }
}
