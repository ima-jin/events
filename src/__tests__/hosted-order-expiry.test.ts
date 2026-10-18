import { describe, expect, it } from 'vitest';
import { makeOrder } from './support/orders-support';
import { HOSTED_ORDER_TTL_MS, withHostedOrderExpiry } from '@/lib/hosted-order-expiry';

const now = new Date('2026-10-18T12:00:00Z');
const createdAt = new Date(now.getTime() - HOSTED_ORDER_TTL_MS);

describe('hosted checkout read-time expiry', () => {
  it.each(['stripe', 'stripe-byo'])('expires a stale pending %s session without modifying storage', (paymentMethod) => {
    const order = makeOrder({ status: 'pending', paymentMethod, stripeSessionId: 'cs_stored', createdAt });
    expect(withHostedOrderExpiry(order, now)).toEqual({ ...order, status: 'expired' });
    expect(order.status).toBe('pending');
    expect(order.stripeSessionId).toBe('cs_stored');
  });

  it.each([
    { createdAt: new Date(createdAt.getTime() + 1) },
    { createdAt: new Date(now.getTime() + 1) },
    { createdAt: null },
    { paymentMethod: 'etransfer' },
    { paymentMethod: 'free' },
    { paymentMethod: 'balance' },
    { paymentMethod: null },
    { stripeSessionId: null },
    { stripeSessionId: ' ' },
    { status: 'completed' },
    { status: 'refunded' },
    { status: 'cancelled' },
    { status: 'expired' },
  ])('leaves fresh, non-hosted and terminal orders untouched: %j', (overrides) => {
    const order = makeOrder({
      status: 'pending', stripeSessionId: 'cs_stored', createdAt, ...overrides,
    });
    expect(withHostedOrderExpiry(order, now)).toBe(order);
  });
});
