/**
 * POST /api/tickets/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for a held ticket.
 * Changes status from 'held' to 'valid' and records confirmation timestamp.
 * Requires event organizer auth.
 *
 * DEPRECATED: Use POST /api/orders/[id]/confirm-payment for order-level
 * confirmation. This route is kept for orphan tickets (tickets without an
 * order) and edge cases only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { isServiceError } from '@/services/errors';
import { confirmTicketPayment } from '@/services/order-confirmation';

const log = createLogger('events');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  log.warn({}, 'POST /api/tickets/[id]/confirm-payment is deprecated; use POST /api/orders/[id]/confirm-payment');

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const actorDid = resolveActingDid(authResult.identity);
  const { id } = await params;

  try {
    const result = await confirmTicketPayment(id, {
      actorDid,
      callerCookie: request.headers.get('cookie'),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'confirm-payment error');
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 });
  }
}
