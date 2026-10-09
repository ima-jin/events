/**
 * POST /api/events/[id]/tickets/[ticketId]/cancel
 *
 * Cancels a held or available (unconfirmed) ticket.
 * Only works for tickets with status 'held' or 'available' — confirmed tickets must use refund.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { isServiceError } from '@/services/errors';
import { cancelTicket } from '@/services/tickets-service';

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
    const result = await cancelTicket({
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
    throw error;
  }
}
