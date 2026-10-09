/**
 * POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent — complete a pending e-transfer refund (organizers only)
 *
 * Flips status from 'refund_pending' to 'refunded'.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { runOrganizerAction } from '@/lib/organizer-action-route';
import { markRefundSent } from '@/services/tickets-service';

const log = createLogger('events');

type RouteContext = { params: Promise<{ id: string; ticketId: string }> };

export function POST(request: NextRequest, { params }: RouteContext) {
  return runOrganizerAction(request, {
    fallback: 'Failed to mark refund as sent',
    log,
    action: async (context) => {
      const { id: eventId, ticketId } = await params;
      return markRefundSent({ eventId, ticketId, ...context });
    },
  });
}
