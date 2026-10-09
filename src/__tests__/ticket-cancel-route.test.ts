/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/cancel/route.ts
 *
 * Key logic: only 'held' or 'available' tickets may be cancelled.
 * 'valid' (paid) tickets must go through refund instead.
 *
 * Cases:
 *  - 401 unauthenticated
 *  - 403 non-organizer
 *  - 404 ticket not found
 *  - 400 when ticket status is 'valid' (must use refund)
 *  - 400 when ticket status is 'refunded' (already done)
 *  - 200 cancels a 'held' ticket
 *  - 200 cancels an 'available' ticket
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mocks, nextDrizzleSelect, resetRouteMocks, ticketRequest, TICKET_ROUTE_PARAMS, testReturns401WhenAuthFails } from './support/route-test-support';

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/cancel/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeRequest = () => ticketRequest('cancel');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events/[id]/tickets/[ticketId]/cancel', () => {
  beforeEach(() => {
    resetRouteMocks();
  });

  testReturns401WhenAuthFails(POST, makeRequest);

  it('returns 403 when caller is not an organizer', async () => {
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextDrizzleSelect([]);
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 400 when ticket status is "valid" (must use refund instead)', async () => {
    nextDrizzleSelect([{ id: 'tkt_1', status: 'valid', eventId: 'evt_1' }]);
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('valid') });
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when ticket status is "refunded"', async () => {
    nextDrizzleSelect([{ id: 'tkt_1', status: 'refunded', eventId: 'evt_1' }]);
    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('cancels a held ticket and returns the updated ticket', async () => {
    const heldTicket = { id: 'tkt_1', status: 'held', eventId: 'evt_1', heldBy: 'did:buyer' };
    const cancelledTicket = { ...heldTicket, status: 'cancelled', heldBy: null, heldUntil: null };
    nextDrizzleSelect([heldTicket]);
    mocks.returningMock.mockResolvedValueOnce([cancelledTicket]);

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('cancelled');
    expect(body.ticket.heldBy).toBeNull();

    // Verify the update set the right fields
    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', heldBy: null, heldUntil: null })
    );
  });

  it('cancels an available ticket', async () => {
    const availableTicket = { id: 'tkt_1', status: 'available', eventId: 'evt_1', heldBy: null };
    nextDrizzleSelect([availableTicket]);
    mocks.returningMock.mockResolvedValueOnce([{ ...availableTicket, status: 'cancelled' }]);

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).ticket.status).toBe('cancelled');
  });
});
