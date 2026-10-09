import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { db, tickets, ticketTypes } from '@/db';

const log = createLogger('events');
import { eq, and, lt } from 'drizzle-orm';
import { authenticateActing, type IdParams, loadEventTicketType } from '@/lib/route-helpers';

const DEFAULT_HOLD_HOURS = 72;

/**
 * POST /api/events/[id]/hold - Hold a ticket
 */
export async function POST(
  request: NextRequest,
  { params }: IdParams
) {
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { identity } = auth;
  const { id } = await params;

  try {
    const body = await request.json();
    const { ticketTypeId, holdHours = DEFAULT_HOLD_HOURS } = body;

    // Check ticket type exists and belongs to this event
    const ticketType = await loadEventTicketType(ticketTypeId, id);
    if (ticketType instanceof NextResponse) return ticketType;

    // Check if user already has a hold for this ticket type
    const [existingHold] = await db
      .select()
      .from(tickets)
      .where(and(
        eq(tickets.ticketTypeId, ticketTypeId),
        eq(tickets.heldBy, identity.id),
        eq(tickets.status, 'held')
      ))
      .limit(1);

    if (existingHold) {
      return NextResponse.json({ 
        error: 'You already have a hold for this ticket type',
        ticket: existingHold 
      }, { status: 409 });
    }

    // Release any expired holds first
    await db
      .update(tickets)
      .set({ 
        status: 'available', 
        heldBy: null, 
        heldUntil: null 
      })
      .where(and(
        eq(tickets.ticketTypeId, ticketTypeId),
        eq(tickets.status, 'held'),
        lt(tickets.heldUntil, new Date())
      ));

    // Check availability
    const available = ticketType.quantity 
      ? ticketType.quantity - (ticketType.sold || 0)
      : Infinity;

    // Count current holds
    const holds = await db
      .select()
      .from(tickets)
      .where(and(
        eq(tickets.ticketTypeId, ticketTypeId),
        eq(tickets.status, 'held')
      ));

    if (ticketType.quantity && holds.length >= available) {
      return NextResponse.json({ 
        error: 'No tickets available',
        queuePosition: holds.length + 1
      }, { status: 409 });
    }

    // Create the hold
    const holdUntil = new Date();
    holdUntil.setHours(holdUntil.getHours() + holdHours);

    const ticketId = `tkt_${Date.now().toString(36)}_0`;

    // Look up ticket type to check requiresRegistration
    const [tt] = await db.select({ requiresRegistration: ticketTypes.requiresRegistration })
      .from(ticketTypes).where(eq(ticketTypes.id, ticketTypeId));

    const [ticket] = await db.insert(tickets).values({
      id: ticketId,
      eventId: id,
      ticketTypeId,
      status: 'held',
      heldBy: identity.id,
      heldUntil: holdUntil,
      registrationStatus: tt?.requiresRegistration ? 'pending' : 'not_required',
    }).returning();

    return NextResponse.json({ 
      ticket,
      expiresAt: holdUntil,
      message: `Ticket held for ${holdHours} hours`
    }, { status: 201 });

  } catch (error) {
    log.error({ err: String(error) }, 'Failed to hold ticket');
    return NextResponse.json({ error: 'Failed to hold ticket' }, { status: 500 });
  }
}

/**
 * DELETE /api/events/[id]/hold - Release a hold
 */
export async function DELETE(request: NextRequest) {
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { identity } = auth;

  try {
    const { searchParams } = new URL(request.url);
    const ticketId = searchParams.get('ticketId');

    if (!ticketId) {
      return NextResponse.json({ error: 'ticketId is required' }, { status: 400 });
    }

    // Find the held ticket
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(
        eq(tickets.id, ticketId),
        eq(tickets.heldBy, identity.id),
        eq(tickets.status, 'held')
      ))
      .limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Hold not found or not yours' }, { status: 404 });
    }

    // Release the hold by deleting the ticket record
    await db
      .delete(tickets)
      .where(eq(tickets.id, ticketId));

    return NextResponse.json({ message: 'Hold released' });

  } catch (error) {
    log.error({ err: String(error) }, 'Failed to release hold');
    return NextResponse.json({ error: 'Failed to release hold' }, { status: 500 });
  }
}
