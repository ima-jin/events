/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route.ts
 *
 * Completes the e-transfer refund flow: organizer clicks "Mark Sent" after
 * manually sending the e-transfer, flipping ticket status from
 * 'refund_pending' → 'refunded'.
 *
 * Note: event lookup uses Drizzle (db.select); ticket SELECT and UPDATE
 * use raw SQL via getClient() — two separate mock systems.
 *
 * Cases:
 *  - 401 unauthenticated
 *  - 404 event not found
 *  - 403 non-organizer
 *  - 404 ticket not found
 *  - 400 ticket not in 'refund_pending' status (e.g. already 'refunded')
 *  - 200 flips 'refund_pending' → 'refunded'
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mocks, nextDrizzleSelect, nextSql, resetRouteMocks, ticketRequest, TICKET_ROUTE_PARAMS, testReturns401WhenAuthFails } from './support/route-test-support';

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeRequest = () => ticketRequest('mark-refund-sent');

const BASE_EVENT = { id: 'evt_1', title: 'Test Event' };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent', () => {
  beforeEach(() => {
    resetRouteMocks();
  });

  testReturns401WhenAuthFails(POST, makeRequest);

  it('returns 404 when event is not found', async () => {
    nextDrizzleSelect([]);
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Event not found' });
  });

  it('returns 403 when caller is not an organizer', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.sqlMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([]);  // ticket SELECT → empty
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 400 when ticket is not in refund_pending status', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([{ id: 'tkt_1', status: 'refunded' }]);  // already refunded
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Ticket is not in refund_pending status' });
    // Only one SQL call (the SELECT) — no UPDATE
    expect(mocks.sqlMock).toHaveBeenCalledOnce();
  });

  it('flips refund_pending to refunded and returns the ticket', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([{ id: 'tkt_1', status: 'refund_pending' }]);          // SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refunded' }]);                // UPDATE RETURNING

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.id).toBe('tkt_1');
    expect(body.ticket.status).toBe('refunded');
  });
});
