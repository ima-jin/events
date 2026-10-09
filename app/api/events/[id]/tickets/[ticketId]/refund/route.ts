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
import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { runOrganizerAction } from '@/lib/organizer-action-route';
import { refundTicket } from '@/services/tickets-service';

const log = createLogger('events');

type RouteContext = { params: Promise<{ id: string; ticketId: string }> };

export function POST(request: NextRequest, { params }: RouteContext) {
  return runOrganizerAction(request, {
    fallback: 'Failed to refund ticket',
    log,
    action: async (context) => {
      const { id: eventId, ticketId } = await params;
      return refundTicket({ eventId, ticketId, ...context });
    },
  });
}
