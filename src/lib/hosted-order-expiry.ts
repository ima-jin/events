import type { Order } from '@/db/schema';

/** Stripe hosted sessions can remain open for up to 24 hours. */
export const HOSTED_ORDER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read-time expiry only: retain the stored pending row and kernel reference so
 * a delayed, verified payment completion can still fulfil the paid checkout.
 * Reports exclude stored pending card orders regardless of their age.
 */
export function withHostedOrderExpiry(order: Order, now = new Date()): Order {
  if (order.status === 'pending'
    && (order.paymentMethod === 'stripe' || order.paymentMethod === 'stripe-byo')
    && order.stripeSessionId?.trim()
    && order.createdAt
    && now.getTime() - order.createdAt.getTime() >= HOSTED_ORDER_TTL_MS) {
    return { ...order, status: 'expired' };
  }
  return order;
}
