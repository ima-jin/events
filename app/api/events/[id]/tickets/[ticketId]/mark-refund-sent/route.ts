import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { isServiceError } from '@/services/errors';
import { markRefundSent } from '@/services/tickets-service';

const log = createLogger('events');

/**
 * POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent — complete a pending e-transfer refund (organizers only)
 *
 * Flips status from 'refund_pending' to 'refunded'.
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
    const result = await markRefundSent({
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
    log.error({ err: String(error) }, 'Failed to mark refund as sent');
    return NextResponse.json({ error: 'Failed to mark refund as sent' }, { status: 500 });
  }
}
