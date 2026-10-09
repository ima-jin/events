/**
 * Tests for app/api/events/[id]/tickets/[ticketId]/refund/route.ts
 *
 * This is the primary user-facing refund action (Guest List → Refund button).
 * The route branches between Stripe, e-transfer, and free tickets, and calls
 * the kernel pay service for Stripe payments.
 *
 * NOTE: the pay-service call still authenticates with PAY_SERVICE_API_KEY
 * (explicitly out of scope — imajin-ai#2739), and is tested as-is.
 *
 * Cases:
 *  - Stripe ticket: pay service succeeds → 200, status 'refunded'
 *  - Stripe ticket: pay service fails → 502, ticket unchanged
 *  - E-transfer ticket → 200, manualRefundRequired + status 'refund_pending'
 *  - Free ticket (pricePaid=0) → 200, no pay service call, status 'refunded'
 *  - Ticket not in 'valid' status → 400
 *  - Ticket not found → 404
 *  - Event not found → 404
 *  - Non-organizer → 403
 *  - Unauthenticated → 401
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BUYER_DID,
  ERR_EVENT_NOT_FOUND,
  ERR_TICKET_NOT_FOUND,
  EVENT_ID,
  ORGANIZER_DID,
  ROUTE_PARAMS,
  TICKET_ID,
  expectPayRefundCall,
  fetchMock,
  getContactEmailMock,
  getSurveyResponseForTicketMock,
  isEventOrganizerMock,
  logMock,
  makeTicketRequest,
  nextSelect,
  nextSql,
  nextUpdateRejection,
  publishMock,
  resetTicketRouteMocks,
  setMock,
  sqlMock,
  sqlStatement,
  updateMock,
  fakeResponse,
  itReturns401WhenAuthFails,
  itReturns403WhenNotOrganizer,
} from './support/ticket-route-support';
import { ticketTypes } from '@/db';
import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/refund/route';

const EVENT_TITLE = 'Test Event';

const BASE_EVENT = {
  id: EVENT_ID,
  title: EVENT_TITLE,
  imageUrl: null,
  isVirtual: false,
  venue: null,
};

const STRIPE_TICKET = {
  id: TICKET_ID,
  status: 'valid',
  price_paid: 27500, // cents
  payment_id: 'pi_test_stripe',
  payment_method: 'stripe',
  ticket_type_id: 'tkt_type_1',
  owner_did: BUYER_DID,
  currency: 'CAD',
};

const ETRANSFER_TICKET = { ...STRIPE_TICKET, payment_method: 'etransfer', payment_id: null };
const FREE_TICKET = { ...STRIPE_TICKET, price_paid: 0, payment_id: null, payment_method: null };

const BUYER_EMAIL = 'buyer@test.com';
const REFUND_PENDING = 'refund_pending';
const TICKET_REFUNDED = 'ticket.refunded';

const callRefund = () => POST(makeTicketRequest('refund'), ROUTE_PARAMS);

/** Queue: event lookup, ticket SELECT, then the status UPDATE ... RETURNING. */
function queueRefund(ticket: Record<string, unknown>, updatedStatus: string): void {
  nextSelect([BASE_EVENT]);
  nextSql([ticket]);
  nextSql([{ id: TICKET_ID, status: updatedStatus }]);
}

/** The `ticket.refunded` payload published for the customer. */
function refundPayload(): Record<string, unknown> {
  const call = publishMock.mock.calls.find(([type]) => type === TICKET_REFUNDED);
  return (call?.[1] as { payload: Record<string, unknown> }).payload;
}

describe('POST /api/events/[id]/tickets/[ticketId]/refund', () => {
  beforeEach(() => {
    resetTicketRouteMocks();
    getContactEmailMock.mockResolvedValue(BUYER_EMAIL);
  });

  itReturns401WhenAuthFails(callRefund);

  itReturns403WhenNotOrganizer(callRefund, () => nextSelect([BASE_EVENT]));

  it('returns 404 when event is not found', async () => {
    nextSelect([]);

    const res = await callRefund();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: ERR_EVENT_NOT_FOUND });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextSelect([BASE_EVENT]);
    nextSql([]); // ticket SELECT → empty

    const res = await callRefund();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: ERR_TICKET_NOT_FOUND });
  });

  it('returns 400 when ticket is not valid (e.g. already refunded)', async () => {
    nextSelect([BASE_EVENT]);
    nextSql([{ ...STRIPE_TICKET, status: 'refunded' }]);

    const res = await callRefund();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Only valid tickets can be refunded' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the pay service fails (Stripe ticket)', async () => {
    nextSelect([BASE_EVENT]);
    nextSql([STRIPE_TICKET]);
    fetchMock.mockResolvedValue(fakeResponse(500, 'Stripe error'));

    const res = await callRefund();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'Payment refund failed — ticket status not changed' });
    expect(logMock.error).toHaveBeenCalledWith(
      { status: 500, text: 'Stripe error' },
      '[refund] pay /api/refund returned error'
    );

    // Ticket status must NOT have been updated, no counter change, no notification
    expect(sqlMock).toHaveBeenCalledOnce(); // only the SELECT, no UPDATE
    expect(updateMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('refunds a Stripe ticket: calls pay service and returns status refunded', async () => {
    queueRefund(STRIPE_TICKET, 'refunded');

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: { id: TICKET_ID, status: 'refunded' } });

    // Pay service called with the ticket's payment ID and price
    expect(expectPayRefundCall()).toEqual({ paymentId: 'pi_test_stripe', amount: 27500 });
    expect(sqlStatement(1)).toContain('UPDATE events.tickets SET status =');
    expect(sqlMock.mock.calls[1].slice(1)).toEqual(['refunded', TICKET_ID]);

    // Domain event published, notifying the customer
    expect(publishMock).toHaveBeenCalledWith(
      TICKET_REFUNDED,
      expect.objectContaining({ issuer: ORGANIZER_DID, subject: BUYER_DID, scope: 'events' })
    );
    expect(refundPayload()).toMatchObject({
      email: BUYER_EMAIL,
      eventTitle: EVENT_TITLE,
      manualRefundRequired: false,
      context_id: EVENT_ID,
      context_type: 'event',
    });
    expect(refundPayload().refundMessage).toContain('$275.00 CAD');
  });

  it('decrements the ticket type sold counter on refund', async () => {
    queueRefund(STRIPE_TICKET, 'refunded');

    await callRefund();

    expect(updateMock).toHaveBeenCalledWith(ticketTypes);
    expect(setMock).toHaveBeenCalledOnce();
  });

  it('skips the sold-counter decrement when the ticket has no ticket_type_id', async () => {
    queueRefund({ ...STRIPE_TICKET, ticket_type_id: null }, 'refunded');

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('still refunds when decrementing the sold counter fails (non-fatal)', async () => {
    queueRefund(STRIPE_TICKET, 'refunded');
    nextUpdateRejection(new Error('db hiccup'));

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect((await res.json()).ticket.status).toBe('refunded');
    expect(logMock.error).toHaveBeenCalledWith(
      { err: 'Error: db hiccup' },
      '[refund] Failed to decrement ticket_types.sold (non-fatal)'
    );
  });

  it('handles an e-transfer ticket: returns manualRefundRequired and refund_pending status', async () => {
    queueRefund(ETRANSFER_TICKET, REFUND_PENDING);

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticket: { id: TICKET_ID, status: REFUND_PENDING },
      manualRefundRequired: true,
      refundEmail: BUYER_EMAIL,
      refundAmount: '275.00',
      refundCurrency: 'CAD',
    });
    expect(sqlMock.mock.calls[1].slice(1)).toEqual([REFUND_PENDING, TICKET_ID]);

    // No Stripe call for e-transfer
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refundPayload()).toMatchObject({ manualRefundRequired: true });
    expect(refundPayload().refundMessage).toContain('e-transfer');
  });

  it('omits refundEmail for an e-transfer refund when no customer email can be resolved', async () => {
    queueRefund(ETRANSFER_TICKET, REFUND_PENDING);
    getContactEmailMock.mockResolvedValue(null);

    const res = await callRefund();

    const body = await res.json();
    expect(body.manualRefundRequired).toBe(true);
    expect(body).not.toHaveProperty('refundEmail');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('handles a free ticket: no pay service call, ticket directly refunded', async () => {
    queueRefund(FREE_TICKET, 'refunded');

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: { id: TICKET_ID, status: 'refunded' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refundPayload().refundMessage).toContain('cancelled and refunded');
  });

  describe('customer notification', () => {
    it('prefers the survey response email over the owner DID lookup', async () => {
      queueRefund(STRIPE_TICKET, 'refunded');
      getSurveyResponseForTicketMock.mockResolvedValue({ answers: { email: 'survey@test.com' } });

      await callRefund();

      expect(getSurveyResponseForTicketMock).toHaveBeenCalledWith(TICKET_ID);
      expect(getContactEmailMock).not.toHaveBeenCalled();
      expect(refundPayload().email).toBe('survey@test.com');
    });

    it('falls back to the kernel contact email for the owner DID', async () => {
      queueRefund(STRIPE_TICKET, 'refunded');

      await callRefund();

      expect(getContactEmailMock).toHaveBeenCalledWith(BUYER_DID);
    });

    it('does not publish when the ticket has no owner and no survey email', async () => {
      queueRefund({ ...STRIPE_TICKET, owner_did: null }, 'refunded');

      const res = await callRefund();

      expect(res.status).toBe(200);
      expect(getContactEmailMock).not.toHaveBeenCalled();
      expect(publishMock).not.toHaveBeenCalled();
    });

    it('absolutizes a relative event image URL', async () => {
      nextSelect([{ ...BASE_EVENT, imageUrl: '/media/cover.png' }]);
      nextSql([STRIPE_TICKET]);
      nextSql([{ id: TICKET_ID, status: 'refunded' }]);

      await callRefund();

      expect(refundPayload().eventImageUrl).toBe('https://events.test/media/cover.png');
    });

    it('keeps an absolute event image URL as-is', async () => {
      nextSelect([{ ...BASE_EVENT, imageUrl: 'https://cdn.test/cover.png' }]);
      nextSql([STRIPE_TICKET]);
      nextSql([{ id: TICKET_ID, status: 'refunded' }]);

      await callRefund();

      expect(refundPayload().eventImageUrl).toBe('https://cdn.test/cover.png');
    });

    it('does not fail the refund when email resolution throws', async () => {
      queueRefund(STRIPE_TICKET, 'refunded');
      getContactEmailMock.mockRejectedValue(new Error('kernel down'));

      const res = await callRefund();

      expect(res.status).toBe(200);
      expect(logMock.error).toHaveBeenCalledWith(
        { err: 'Error: kernel down' },
        '[refund] Failed to publish refund event (non-fatal)'
      );
    });

    it('does not fail the refund when publishing rejects', async () => {
      queueRefund(STRIPE_TICKET, 'refunded');
      publishMock.mockRejectedValue(new Error('bus down'));

      const res = await callRefund();

      expect(res.status).toBe(200);
      await vi.waitFor(() =>
        expect(logMock.error).toHaveBeenCalledWith(
          { err: 'Error: bus down' },
          '[refund] Failed to publish ticket refunded event'
        )
      );
    });
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    nextSelect([BASE_EVENT]);
    sqlMock.mockRejectedValueOnce(new Error('db down'));

    const res = await callRefund();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to refund ticket' });
  });
});
