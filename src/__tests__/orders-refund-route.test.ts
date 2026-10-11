/**
 * Tests for app/api/orders/[id]/refund/route.ts
 *
 * Covers the order-level refund endpoint introduced in #949:
 *  - Successful full-order Stripe refund → tickets marked 'refunded', order updated
 *  - Already-refunded order → 400
 *  - Pay service failure → 502, ticket statuses unchanged
 *  - No refundable tickets → 400
 *  - Non-organizer caller → 403
 *  - Free/e-transfer orders skip the Stripe call
 *
 * NOTE: the pay-service call still authenticates with PAY_SERVICE_API_KEY
 * (explicitly out of scope — imajin-ai#2739), and is tested as-is.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BUYER_DID,
  CALLER_COOKIE,
  EVENT_ID,
  ORGANIZER_DID,
  expectPayRefundCall,
  fakeResponse,
  fetchMock,
  isEventOrganizerMock,
  logMock,
  makeRequest,
  nextSelect,
  nextUpdateRejection,
  publishMock,
  resetTicketRouteMocks,
  setMock,
  updatedTables,
  updateMock,
  itReturns401WhenAuthFails,
  itReturns403WhenNotOrganizer,
} from './support/ticket-route-support';
import { orders, ticketTypes, tickets } from '@/db';
import { POST } from '../../app/api/orders/[id]/refund/route';

const ORDER_ID = 'ord_test_1';
const ORDER_REFUNDED = 'order.refunded';
const PAYMENT_INTENT = 'pi_test_intent';

const BASE_ORDER = {
  id: ORDER_ID,
  eventId: EVENT_ID,
  buyerDid: BUYER_DID,
  amountTotal: 55000, // $550 in cents
  currency: 'CAD',
  paymentMethod: 'stripe',
  paymentId: PAYMENT_INTENT,
  stripeSessionId: 'cs_test_session',
  status: 'completed',
  metadata: {},
};

function makeTicket(id: string, ticketTypeId = 'tkt_type_1') {
  return {
    id,
    orderId: ORDER_ID,
    eventId: EVENT_ID,
    ticketTypeId,
    status: 'valid',
    pricePaid: 27500,
    currency: 'CAD',
    ownerDid: BUYER_DID,
    paymentMethod: 'stripe',
    paymentId: PAYMENT_INTENT,
  };
}

const BASE_TICKETS = [makeTicket('tkt_1'), makeTicket('tkt_2')];

const orderParams = (id = ORDER_ID) => ({ params: Promise.resolve({ id }) });
const callRefund = (id = ORDER_ID) => POST(makeRequest(`/api/orders/${id}/refund`), orderParams(id));

describe('POST /api/orders/[id]/refund (#949)', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callRefund);

  itReturns403WhenNotOrganizer(callRefund, () => nextSelect([BASE_ORDER]), CALLER_COOKIE);

  it('returns 404 when order is not found', async () => {
    nextSelect([]); // no order

    const res = await callRefund('ord_missing');

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  it('returns 400 when order is already refunded', async () => {
    nextSelect([{ ...BASE_ORDER, status: 'refunded' }]);

    const res = await callRefund();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Order already refunded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks organizer rights against the order\'s event', async () => {
    nextSelect([{ ...BASE_ORDER, eventId: 'evt_other' }]);
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await callRefund();

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Only event organizers can issue refunds');
    expect(isEventOrganizerMock).toHaveBeenCalledWith('evt_other', ORGANIZER_DID, CALLER_COOKIE);
  });

  it('returns 400 when the order has no refundable tickets', async () => {
    nextSelect([BASE_ORDER]); // order found
    nextSelect([]); // no valid/used tickets

    const res = await callRefund();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no refundable/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 and leaves tickets unchanged when pay service fails', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect(BASE_TICKETS);
    fetchMock.mockResolvedValue(fakeResponse(500, 'Stripe error'));

    const res = await callRefund();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/payment refund failed/i);
    expect(logMock.error).toHaveBeenCalledWith(
      { status: 500, text: 'Stripe error' },
      '[order-refund] pay /api/refund returned error'
    );

    // Nothing was updated or published
    expect(updateMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('refunds all tickets and updates order status on success', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect(BASE_TICKETS);

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderId: ORDER_ID, refundedTickets: 2, status: 'refunded' });

    // Pay service called with the order's paymentId, no amount (= full refund)
    expect(expectPayRefundCall()).toEqual({ paymentId: PAYMENT_INTENT, reason: 'order refund' });

    // Tickets, their type's sold counter and the order are all updated
    expect(updatedTables()).toEqual([tickets, ticketTypes, orders]);
    expect(setMock).toHaveBeenNthCalledWith(1, { status: 'refunded' });
    expect(setMock).toHaveBeenNthCalledWith(3, { status: 'refunded' });

    // Domain event published
    expect(publishMock).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledWith(ORDER_REFUNDED, {
      issuer: ORGANIZER_DID,
      subject: BUYER_DID,
      scope: 'events',
      payload: {
        orderId: ORDER_ID,
        eventId: EVENT_ID,
        ticketIds: ['tkt_1', 'tkt_2'],
        amountTotal: 55000,
        currency: 'CAD',
        isStripe: true,
      },
    });
  });

  it('decrements the sold counter once per distinct ticket type', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect([makeTicket('tkt_1', 'type_a'), makeTicket('tkt_2', 'type_b'), makeTicket('tkt_3', 'type_a')]);

    const res = await callRefund();

    expect((await res.json()).refundedTickets).toBe(3);
    expect(updatedTables()).toEqual([tickets, ticketTypes, ticketTypes, orders]);
  });

  it('still refunds when decrementing a sold counter fails (non-fatal)', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect(BASE_TICKETS);
    nextUpdateRejection(new Error('counter fail'), 1); // tickets update succeeds, ticket_types update rejects

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('refunded');
    expect(logMock.error).toHaveBeenCalledWith(
      { err: 'Error: counter fail' },
      '[order-refund] Failed to decrement ticket_types.sold (non-fatal)'
    );
    expect(updatedTables()).toEqual([tickets, ticketTypes, orders]); // order still marked refunded
  });

  it('skips Stripe call for free/e-transfer orders and still marks tickets', async () => {
    nextSelect([{ ...BASE_ORDER, paymentMethod: 'etransfer', paymentId: null }]);
    nextSelect(BASE_TICKETS);

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled(); // no pay-service call for non-Stripe orders
    expect((await res.json()).refundedTickets).toBe(2);
    expect(publishMock).toHaveBeenCalledWith(
      ORDER_REFUNDED,
      expect.objectContaining({ payload: expect.objectContaining({ isStripe: false }) })
    );
  });

  it('falls back to an "unknown" subject when the order has no buyer DID', async () => {
    nextSelect([{ ...BASE_ORDER, buyerDid: null }]);
    nextSelect(BASE_TICKETS);

    await callRefund();

    expect(publishMock).toHaveBeenCalledWith(ORDER_REFUNDED, expect.objectContaining({ subject: 'unknown' }));
  });

  it('does not fail the refund when publishing rejects', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect(BASE_TICKETS);
    publishMock.mockRejectedValue(new Error('bus down'));

    const res = await callRefund();

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(logMock.error).toHaveBeenCalledWith(
        { err: 'Error: bus down' },
        '[order-refund] Failed to publish order.refunded'
      )
    );
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect(BASE_TICKETS);
    fetchMock.mockRejectedValue(new Error('network down'));

    const res = await callRefund();

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to refund order');
  });
});
