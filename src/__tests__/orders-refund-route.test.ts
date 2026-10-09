/**
 * Tests for apps/events/app/api/orders/[id]/refund/route.ts
 *
 * Covers the new order-level refund endpoint introduced in #949:
 *  - Successful full-order Stripe refund → tickets marked 'refunded', order updated
 *  - Already-refunded order → 400
 *  - Pay service failure → 502, ticket statuses unchanged
 *  - No refundable tickets → 400
 *  - Non-organizer caller → 403
 *  - Free/e-transfer orders skip the Stripe call
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mocks, nextDrizzleSelect, resetRouteMocks } from './support/route-test-support';

const extra = vi.hoisted(() => ({ fetchMock: vi.fn() }));

import { POST } from '../../app/api/orders/[id]/refund/route';

function makeRequest(): NextRequest {
  return new NextRequest('https://events.test/api/orders/ord_test_1/refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'session=abc' },
  });
}

const BASE_ORDER = {
  id: 'ord_test_1',
  eventId: 'evt_test_1',
  buyerDid: 'did:imajin:buyer',
  amountTotal: 55000,  // $550 in cents
  currency: 'CAD',
  paymentMethod: 'stripe',
  paymentId: 'pi_test_intent',
  stripeSessionId: 'cs_test_session',
  status: 'completed',
  purchasedAt: new Date().toISOString(),
  metadata: {},
};

const BASE_TICKETS = [
  {
    id: 'tkt_1',
    orderId: 'ord_test_1',
    eventId: 'evt_test_1',
    ticketTypeId: 'tkt_type_1',
    status: 'valid',
    pricePaid: 27500,
    currency: 'CAD',
    ownerDid: 'did:imajin:buyer',
    paymentMethod: 'stripe',
    paymentId: 'pi_test_intent',
  },
  {
    id: 'tkt_2',
    orderId: 'ord_test_1',
    eventId: 'evt_test_1',
    ticketTypeId: 'tkt_type_1',
    status: 'valid',
    pricePaid: 27500,
    currency: 'CAD',
    ownerDid: 'did:imajin:buyer',
    paymentMethod: 'stripe',
    paymentId: 'pi_test_intent',
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/orders/[id]/refund (#949)', () => {
  beforeEach(() => {
    resetRouteMocks();
    process.env.PAY_SERVICE_URL = 'http://kernel-test';
    process.env.PAY_SERVICE_API_KEY = 'service-key';
    
    vi.stubGlobal('fetch', extra.fetchMock);
    extra.fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
  });

  it('returns 401 when auth fails', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when order is not found', async () => {
    nextDrizzleSelect([]);  // no order

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_missing' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 when order is already refunded', async () => {
    nextDrizzleSelect([{ ...BASE_ORDER, status: 'refunded' }]);

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Order already refunded');
    expect(extra.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is not an organizer', async () => {
    nextDrizzleSelect([BASE_ORDER]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(403);
    expect(extra.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the order has no refundable tickets', async () => {
    nextDrizzleSelect([BASE_ORDER]);   // order found
    nextDrizzleSelect([]);             // no valid/used tickets

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no refundable/i);
    expect(extra.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 and leaves tickets unchanged when pay service fails', async () => {
    nextDrizzleSelect([BASE_ORDER]);
    nextDrizzleSelect(BASE_TICKETS);
    extra.fetchMock.mockResolvedValue({
      ok: false,
      text: async () => 'Stripe error',
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/payment refund failed/i);

    // Ticket status must NOT have been updated
    expect(mocks.setMock).not.toHaveBeenCalledWith({ status: 'refunded' });
  });

  it('refunds all tickets and updates order status on success', async () => {
    nextDrizzleSelect([BASE_ORDER]);
    nextDrizzleSelect(BASE_TICKETS);

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orderId).toBe('ord_test_1');
    expect(body.refundedTickets).toBe(2);
    expect(body.status).toBe('refunded');

    // Pay service was called with the order's paymentId
    expect(extra.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = extra.fetchMock.mock.calls[0];
    expect(url).toContain('/api/refund');
    const reqBody = JSON.parse(init.body);
    expect(reqBody.paymentId).toBe('pi_test_intent');

    // Tickets and order both updated to 'refunded'
    const statusUpdates = mocks.setMock.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status);
    expect(statusUpdates.filter((s: string) => s === 'refunded').length).toBeGreaterThanOrEqual(2);

    // Bus event published
    expect(mocks.publishMock).toHaveBeenCalledOnce();
    const [eventType] = mocks.publishMock.mock.calls[0];
    expect(eventType).toBe('order.refunded');
  });

  it('skips Stripe call for free/e-transfer orders and still marks tickets', async () => {
    const freeOrder = { ...BASE_ORDER, paymentMethod: 'etransfer', paymentId: null };
    nextDrizzleSelect([freeOrder]);
    nextDrizzleSelect(BASE_TICKETS);

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(200);

    // No fetch call for non-Stripe orders
    expect(extra.fetchMock).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.refundedTickets).toBe(2);
  });
});
