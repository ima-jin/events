/**
 * POST /api/tickets/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for a held ticket.
 * Changes status from 'held' to 'valid' and records confirmation timestamp.
 * Requires event organizer auth.
 *
 * DEPRECATED: Use POST /api/orders/[id]/confirm-payment for order-level
 * confirmation. This route is kept for orphan tickets (tickets without an
 * order) and edge cases only.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { runOrganizerAction } from '@/lib/organizer-action-route';
import { confirmTicketPayment } from '@/services/order-confirmation';

const log = createLogger('events');

type RouteContext = { params: Promise<{ id: string }> };

export function POST(request: NextRequest, { params }: RouteContext) {
  log.warn({}, 'POST /api/tickets/[id]/confirm-payment is deprecated; use POST /api/orders/[id]/confirm-payment');

  return runOrganizerAction(request, {
    fallback: 'Failed to confirm payment',
    log,
    action: async (context) => confirmTicketPayment((await params).id, context),
  });
}
