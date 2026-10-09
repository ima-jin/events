/**
 * POST /api/orders/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for an order atomically.
 * Changes all held tickets in the order from 'held' to 'valid'.
 * Requires event organizer auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { db, tickets, orders } from '@/db';
import { confirmHeldTickets } from '@/lib/confirm-payment';
import { eq, and } from 'drizzle-orm';
import { authenticateActing, forbidUnlessOrganizer, type IdParams } from '@/lib/route-helpers';

const log = createLogger('events');

export async function POST(
  request: NextRequest,
  { params }: IdParams
) {
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;
  const { id: orderId } = await params;

  try {
    // Find the order
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (order.status !== 'pending') {
      return NextResponse.json({ error: 'Order is not in pending status' }, { status: 400 });
    }

    // Verify caller is an event organizer
    const forbidden = await forbidUnlessOrganizer(order.eventId, did, request, 'Not authorized');
    if (forbidden) return forbidden;

    // Find all held e-Transfer tickets in this order
    const heldTickets = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.orderId, orderId),
          eq(tickets.status, 'held'),
          eq(tickets.paymentMethod, 'etransfer')
        )
      );

    if (heldTickets.length === 0) {
      return NextResponse.json(
        { error: 'No held e-Transfer tickets found in this order' },
        { status: 400 }
      );
    }

    const { confirmedTickets } = await confirmHeldTickets(order.eventId, heldTickets, orderId);

    return NextResponse.json({
      confirmedCount: confirmedTickets.length,
      orderId,
      tickets: confirmedTickets.map((t) => t.id),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Order confirm-payment error');
    return NextResponse.json(
      { error: 'Failed to confirm payment' },
      { status: 500 }
    );
  }
}
