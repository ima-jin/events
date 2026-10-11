/**
 * GET /api/events/:id/tickets/:ticketId/registration-status
 *
 * Returns the authoritative registration status for a ticket from the DB.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { eq, and } from 'drizzle-orm';

const log = createLogger('events');
import { requireActor } from '@/lib/route-guards';
import { isEventOrganizer } from '@/lib/organizer';
import { db, tickets, ticketTypes } from '@/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ticketId: string }> }
) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;

  const { did } = actor;
  const { id: eventId, ticketId } = await params;

  try {
    // Load ticket with its type
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
      .limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Auth: ticket owner OR event organizer
    const orgCheck = await isEventOrganizer(eventId, did, request);
    if (ticket.ownerDid !== did && !orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Load ticket type to get survey/form ID
    const [type] = await db
      .select({ registrationFormId: ticketTypes.registrationFormId })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticket.ticketTypeId))
      .limit(1);

    const status = ticket.registrationStatus || 'not_required';

    return NextResponse.json({
      status,
      ticketId,
      surveyId: type?.registrationFormId ?? null,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch registration status');
    return NextResponse.json(
      { error: 'Failed to fetch registration status' },
      { status: 500 }
    );
  }
}
