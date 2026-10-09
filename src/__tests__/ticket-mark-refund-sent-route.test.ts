/**
 * Tests for app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route.ts
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
 *  - 500 on an unexpected error
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CALLER_COOKIE,
  ERR_EVENT_NOT_FOUND,
  ERR_TICKET_NOT_FOUND,
  EVENT_ID,
  ROUTE_PARAMS,
  TICKET_ID,
  makeTicketRequest,
  nextSelect,
  nextSql,
  resetTicketRouteMocks,
  sqlStatement,
  itReturns401WhenAuthFails,
  itReturns403WhenNotOrganizer,
  isEventOrganizerMock,
  logMock,
  sqlMock,
} from './support/ticket-route-support';
import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route';

const REFUND_PENDING = 'refund_pending';
const BASE_EVENT = { id: EVENT_ID, title: 'Test Event' };

const callMarkSent = () => POST(makeTicketRequest('mark-refund-sent'), ROUTE_PARAMS);

describe('POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callMarkSent);

  itReturns403WhenNotOrganizer(callMarkSent, () => nextSelect([BASE_EVENT]), CALLER_COOKIE);

  it('returns 404 when event is not found', async () => {
    nextSelect([]);

    const res = await callMarkSent();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: ERR_EVENT_NOT_FOUND });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextSelect([BASE_EVENT]);
    nextSql([]); // ticket SELECT → empty

    const res = await callMarkSent();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: ERR_TICKET_NOT_FOUND });
  });

  it('returns 400 when ticket is not in refund_pending status', async () => {
    nextSelect([BASE_EVENT]);
    nextSql([{ id: TICKET_ID, status: 'refunded' }]); // already refunded

    const res = await callMarkSent();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Ticket is not in refund_pending status' });
    // Only one SQL call (the SELECT) — no UPDATE
    expect(sqlMock).toHaveBeenCalledOnce();
  });

  it('flips refund_pending to refunded and returns the ticket', async () => {
    nextSelect([BASE_EVENT]);
    nextSql([{ id: TICKET_ID, status: REFUND_PENDING }]); // SELECT ticket
    nextSql([{ id: TICKET_ID, status: 'refunded' }]); // UPDATE RETURNING

    const res = await callMarkSent();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: { id: TICKET_ID, status: 'refunded' } });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, 'did:imajin:organizer', CALLER_COOKIE);
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(sqlStatement(0)).toContain('SELECT id, status FROM events.tickets');
    expect(sqlStatement(1)).toContain("UPDATE events.tickets SET status = 'refunded'");
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    nextSelect([BASE_EVENT]);
    sqlMock.mockRejectedValueOnce(new Error('db down'));

    const res = await callMarkSent();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to mark refund as sent' });
    expect(logMock.error).toHaveBeenCalled();
  });
});
