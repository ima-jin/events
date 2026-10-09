import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { isServiceError } from '@/services/errors';
import { refundTicket } from '@/services/tickets-service';

const log = createLogger('events');

/**
 * POST /api/events/[id]/tickets/[ticketId]/refund — refund a ticket (organizers only)
 *
 * - Stripe tickets: calls pay service to issue actual refund before flipping status
 * - E-transfer tickets: flips status only, returns manualRefundRequired: true
 * - Free tickets (price_paid === 0): skips pay service call
 * - Decrements ticket_types.sold counter (failure is non-fatal)
 *
 * The rules live in `refundTicket` (services/tickets-service).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ticketId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const actorDid = resolveActingDid(authResult.identity);
  const { id: eventId, ticketId } = await params;

  try {
    const result = await refundTicket({
      eventId,
      ticketId,
      actorDid,
      callerCookie: request.headers.get('cookie'),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Failed to refund ticket');
    return NextResponse.json({ error: 'Failed to refund ticket' }, { status: 500 });
  }
}
