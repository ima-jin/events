import { NextResponse } from 'next/server';
import { withLogger } from '@ima-jin/logger';
import { db, events, ticketTypes } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { authenticateActing } from '@/lib/route-helpers';

/**
 * GET /api/events/mine - Get all events created by authenticated user
 */
export const GET = withLogger('events', async (request, { log }) => {
  // Require authentication
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;

  try {
    // Get all events created by this user
    const userEvents = await db
      .select()
      .from(events)
      .where(eq(events.creatorDid, did))
      .orderBy(desc(events.createdAt));

    // For each event, get ticket types and calculate sold/revenue
    const eventsWithStats = await Promise.all(
      userEvents.map(async (event) => {
        const types = await db
          .select()
          .from(ticketTypes)
          .where(eq(ticketTypes.eventId, event.id));

        const totalTicketsSold = types.reduce((sum, t) => sum + (t.sold || 0), 0);
        const totalRevenue = types.reduce((sum, t) => sum + (t.sold || 0) * t.price, 0);

        // Determine status badge
        let statusBadge = event.status;
        const now = new Date();
        const eventDate = new Date(event.startsAt);

        if (event.status === 'published') {
          if (eventDate < now) {
            statusBadge = 'past';
          } else {
            statusBadge = 'live';
          }
        }

        return {
          ...event,
          ticketsSold: totalTicketsSold,
          revenue: totalRevenue,
          statusBadge,
          ticketTypes: types,
        };
      })
    );

    return NextResponse.json({ events: eventsWithStats });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch user events');
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
});
