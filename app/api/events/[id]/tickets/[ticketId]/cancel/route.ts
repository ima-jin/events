/**
 * POST /api/events/[id]/tickets/[ticketId]/cancel
 *
 * Cancels a held or available (unconfirmed) ticket.
 * Only works for tickets with status 'held' or 'available' — confirmed tickets must use refund.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, tickets } from '@/db';
import { resolveActingDid } from '@/lib/auth';
import { createLogger } from '@ima-jin/logger';
import { authenticateActing, forbidUnlessOrganizer, type TicketParams } from '@/lib/route-helpers';

const log = createLogger('events');

export async function POST(
  request: NextRequest,
  { params }: TicketParams
) {
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { identity } = auth;
  const actingDid = resolveActingDid(identity);
  const { id: eventId, ticketId } = await params;

  // Verify event ownership (creator or cohost)
  const forbidden = await forbidUnlessOrganizer(eventId, actingDid, request, 'Not authorized');
  if (forbidden) return forbidden;

  // Fetch the ticket
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
    .limit(1);

  if (!ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  if (ticket.status !== 'held' && ticket.status !== 'available') {
    return NextResponse.json(
      { error: `Cannot cancel a ticket with status '${ticket.status}'. Only held or available tickets can be cancelled.` },
      { status: 400 }
    );
  }

  // Cancel the ticket
  const [updated] = await db
    .update(tickets)
    .set({
      status: 'cancelled',
      heldBy: null,
      heldUntil: null,
    })
    .where(eq(tickets.id, ticketId))
    .returning();

  log.info({ ticketId, eventId, previousStatus: ticket.status }, 'Ticket cancelled');

  return NextResponse.json({ ticket: updated });
}
