/**
 * Tests for app/api/events/[id]/tickets/[ticketId]/cancel/route.ts
 *
 * Key logic: only 'held' or 'available' tickets may be cancelled.
 * 'valid' (paid) tickets must go through refund instead.
 *
 * Cases:
 *  - 401 unauthenticated
 *  - 403 non-organizer (before any ticket lookup)
 *  - 404 ticket not found
 *  - 400 when ticket status is 'valid' (must use refund) or 'refunded'
 *  - 200 cancels a 'held' ticket
 *  - 200 cancels an 'available' ticket
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CALLER_COOKIE,
  EVENT_ID,
  ERR_TICKET_NOT_FOUND,
  ROUTE_PARAMS,
  makeTicketRequest,
  nextSelect,
  nextReturning,
  resetTicketRouteMocks,
  itReturns401WhenAuthFails,
  itReturns403WhenNotOrganizer,
  selectMock,
  updateMock,
  setMock,
} from './support/ticket-route-support';
import { tickets } from '@/db';
import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/cancel/route';

const callCancel = () => POST(makeTicketRequest('cancel'), ROUTE_PARAMS);

describe('POST /api/events/[id]/tickets/[ticketId]/cancel', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callCancel);

  itReturns403WhenNotOrganizer(callCancel, undefined, CALLER_COOKIE);

  it('returns 404 when ticket is not found', async () => {
    nextSelect([]);

    const res = await callCancel();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: ERR_TICKET_NOT_FOUND });
  });

  it.each(['valid', 'refunded'])(
    'returns 400 when ticket status is "%s" (only held/available can be cancelled)',
    async (status) => {
      nextSelect([{ id: 'tkt_1', status, eventId: EVENT_ID }]);

      const res = await callCancel();

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining(`'${status}'`) });
      expect(updateMock).not.toHaveBeenCalled();
    }
  );

  it('cancels a held ticket, clearing the hold, and returns the updated ticket', async () => {
    const heldTicket = { id: 'tkt_1', status: 'held', eventId: EVENT_ID, heldBy: 'did:buyer' };
    nextSelect([heldTicket]);
    nextReturning([{ ...heldTicket, status: 'cancelled', heldBy: null, heldUntil: null }]);

    const res = await callCancel();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('cancelled');
    expect(body.ticket.heldBy).toBeNull();
    expect(selectMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledWith(tickets);
    expect(setMock).toHaveBeenCalledWith({ status: 'cancelled', heldBy: null, heldUntil: null });
  });

  it('cancels an available ticket', async () => {
    const availableTicket = { id: 'tkt_1', status: 'available', eventId: EVENT_ID, heldBy: null };
    nextSelect([availableTicket]);
    nextReturning([{ ...availableTicket, status: 'cancelled' }]);

    const res = await callCancel();

    expect(res.status).toBe(200);
    expect((await res.json()).ticket.status).toBe('cancelled');
  });
});
