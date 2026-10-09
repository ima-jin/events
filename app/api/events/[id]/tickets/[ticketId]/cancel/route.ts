/**
 * POST /api/events/[id]/tickets/[ticketId]/cancel
 *
 * Cancels a held or available (unconfirmed) ticket.
 * Only works for tickets with status 'held' or 'available' — confirmed tickets must use refund.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { runOrganizerAction } from '@/lib/organizer-action-route';
import { cancelTicket } from '@/services/tickets-service';

const log = createLogger('events');

type RouteContext = { params: Promise<{ id: string; ticketId: string }> };

export function POST(request: NextRequest, { params }: RouteContext) {
  return runOrganizerAction(request, {
    fallback: 'Failed to cancel ticket',
    log,
    rethrowUnexpected: true,
    action: async (context) => {
      const { id: eventId, ticketId } = await params;
      return cancelTicket({ eventId, ticketId, ...context });
    },
  });
}
