import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { db, events, getClient } from '@/db';

const log = createLogger('events');
import { eq } from 'drizzle-orm';
import { authenticateActing, forbidUnlessOrganizer, type TicketParams } from '@/lib/route-helpers';

const sqlClient = getClient();

/**
 * POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent — complete a pending e-transfer refund (owner only)
 *
 * Flips status from 'refund_pending' to 'refunded'.
 */
export async function POST(
  request: NextRequest,
  { params }: TicketParams
) {
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;
  const { id, ticketId } = await params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const forbidden = await forbidUnlessOrganizer(id, did, request, 'Only event organizers can mark refunds as sent');
    if (forbidden) return forbidden;

    const [ticket] = await sqlClient`
      SELECT id, status
      FROM events.tickets
      WHERE id = ${ticketId} AND event_id = ${id}
      LIMIT 1
    `;

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'refund_pending') {
      return NextResponse.json(
        { error: 'Ticket is not in refund_pending status' },
        { status: 400 }
      );
    }

    const [updated] = await sqlClient`
      UPDATE events.tickets
      SET status = 'refunded'
      WHERE id = ${ticketId}
      RETURNING id, status
    `;

    return NextResponse.json({ ticket: { id: updated.id, status: updated.status } });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to mark refund as sent');
    return NextResponse.json({ error: 'Failed to mark refund as sent' }, { status: 500 });
  }
}
