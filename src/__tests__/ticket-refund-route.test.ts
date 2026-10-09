/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/refund/route.ts
 *
 * This is the primary user-facing refund action (Guest List → Refund button).
 * The route branches between Stripe, e-transfer, and free tickets, and calls
 * the kernel pay service for Stripe payments.
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mocks, nextDrizzleSelect, nextSql, resetRouteMocks, ticketRequest, TICKET_ROUTE_PARAMS, testReturns401WhenAuthFails } from './support/route-test-support';

const extra = vi.hoisted(() => ({
  resolveEmailForDidMock: vi.fn().mockResolvedValue(null),
  getSurveyResponseForTicketMock: vi.fn().mockResolvedValue(null),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kernel')>()),
  getContactEmail: extra.resolveEmailForDidMock,
}));

vi.mock('@/lib/ticket-survey', () => ({
  getSurveyResponseForTicket: extra.getSurveyResponseForTicketMock,
}));

vi.mock('@ima-jin/config', () => ({
  eventUrl: () => 'https://events.test/e/evt_1',
  buildPublicUrlAbsolute: () => 'https://events.test',
}));

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/refund/route';

const makeRequest = () => ticketRequest('refund');

const BASE_EVENT = {
  id: 'evt_1',
  title: 'Test Event',
  imageUrl: null,
  isVirtual: false,
  venue: null,
};

const STRIPE_TICKET = {
  id: 'tkt_1',
  status: 'valid',
  price_paid: 27500,          // cents
  payment_id: 'pi_test_stripe',
  payment_method: 'stripe',
  ticket_type_id: 'tkt_type_1',
  owner_did: 'did:imajin:buyer',
  currency: 'CAD',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events/[id]/tickets/[ticketId]/refund', () => {
  beforeEach(() => {
    resetRouteMocks();
    extra.resolveEmailForDidMock.mockResolvedValue('buyer@test.com');
    extra.getSurveyResponseForTicketMock.mockResolvedValue(null);
    
    process.env.PAY_SERVICE_URL = 'http://kernel-test';
    process.env.PAY_SERVICE_API_KEY = 'service-key';
    
    vi.stubGlobal('fetch', extra.fetchMock);
    extra.fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
  });

  testReturns401WhenAuthFails(POST, makeRequest);

  it('returns 404 when event is not found', async () => {
    nextDrizzleSelect([]);  // event not found
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Event not found' });
  });

  it('returns 403 when caller is not an organizer', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(extra.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([]);  // ticket SELECT → empty
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 400 when ticket is not valid (e.g. already refunded)', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([{ ...STRIPE_TICKET, status: 'refunded' }]);
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Only valid tickets can be refunded' });
    expect(extra.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the pay service fails (Stripe ticket)', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([STRIPE_TICKET]);
    extra.fetchMock.mockResolvedValue({ ok: false, text: async () => 'Stripe error' });

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'Payment refund failed — ticket status not changed' });

    // Ticket status must NOT have been updated
    expect(mocks.sqlMock).toHaveBeenCalledOnce(); // only the SELECT, no UPDATE
  });

  it('refunds a Stripe ticket: calls pay service and returns status refunded', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([STRIPE_TICKET]);                  // (1) SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refunded' }]); // (2) UPDATE ticket RETURNING

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('refunded');
    expect(body.manualRefundRequired).toBeUndefined();

    // Pay service called with the ticket's payment ID and price
    expect(extra.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = extra.fetchMock.mock.calls[0];
    expect(url).toContain('/api/refund');
    const reqBody = JSON.parse(init.body);
    expect(reqBody.paymentId).toBe('pi_test_stripe');
    expect(reqBody.amount).toBe(27500);

    // Bus event published
    expect(mocks.publishMock).toHaveBeenCalledWith(
      'ticket.refunded',
      expect.objectContaining({ payload: expect.objectContaining({ manualRefundRequired: false }) })
    );
  });

  it('handles an e-transfer ticket: returns manualRefundRequired and refund_pending status', async () => {
    const etransferTicket = {
      ...STRIPE_TICKET,
      payment_method: 'etransfer',
      payment_id: null,
    };

    nextDrizzleSelect([BASE_EVENT]);
    nextSql([etransferTicket]);                         // (1) SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refund_pending' }]); // (2) UPDATE ticket RETURNING

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('refund_pending');
    expect(body.manualRefundRequired).toBe(true);
    expect(body.refundAmount).toBe('275.00');

    // No Stripe call for e-transfer
    expect(extra.fetchMock).not.toHaveBeenCalled();
  });

  it('handles a free ticket: no pay service call, ticket directly refunded', async () => {
    const freeTicket = {
      ...STRIPE_TICKET,
      price_paid: 0,
      payment_id: null,
      payment_method: null,
    };

    nextDrizzleSelect([BASE_EVENT]);
    nextSql([freeTicket]);                             // (1) SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refunded' }]);   // (2) UPDATE ticket RETURNING

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).ticket.status).toBe('refunded');
    expect(extra.fetchMock).not.toHaveBeenCalled();
  });
});
