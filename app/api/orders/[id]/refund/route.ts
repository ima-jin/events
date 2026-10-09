/**
 * POST /api/orders/[id]/refund
 *
 * Refunds an entire order atomically (organizer-only). All business rules
 * (Stripe vs free/e-transfer, ticket + order status, sold counters, the
 * `order.refunded` event) live in `refundOrder` (services/orders-service).
 *
 * This endpoint is designed for the "refund entire order" case. Per-ticket
 * partial refunds are handled by the individual ticket refund route.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { runOrganizerAction } from '@/lib/organizer-action-route';
import { refundOrder } from '@/services/orders-service';

const log = createLogger('events');

type RouteContext = { params: Promise<{ id: string }> };

export function POST(request: NextRequest, { params }: RouteContext) {
  return runOrganizerAction(request, {
    fallback: 'Failed to refund order',
    log,
    action: async (context) => refundOrder({ orderId: (await params).id, ...context }),
  });
}
