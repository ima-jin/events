/**
 * POST /api/orders/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for an order atomically.
 * Changes all held tickets in the order from 'held' to 'valid'.
 * Requires event organizer auth.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { runOrganizerAction } from '@/lib/organizer-action-route';
import { confirmOrderPayment } from '@/services/order-confirmation';

const log = createLogger('events');

type RouteContext = { params: Promise<{ id: string }> };

export function POST(request: NextRequest, { params }: RouteContext) {
  return runOrganizerAction(request, {
    fallback: 'Failed to confirm payment',
    log,
    action: async (context) => confirmOrderPayment((await params).id, context),
  });
}
