/**
 * Tests for app/api/events/[id]/tickets/[ticketId]/registration-status/route.ts
 *
 * Auth is ticket-owner OR organizer (either passes).
 * Two Drizzle selects: ticket first, then ticket type for the surveyId.
 *
 * Cases:
 *  - 401 unauthenticated
 *  - 404 ticket not found
 *  - 403 when caller is neither owner nor organizer
 *  - 200 when caller is the ticket owner (non-organizer)
 *  - 200 when caller is an organizer (not the owner)
 *  - Returns correct registration status and surveyId from ticket type
 *  - 500 on an unexpected error
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ERR_TICKET_NOT_FOUND,
  EVENT_ID,
  ROUTE_PARAMS,
  TICKET_ID,
  makeTicketRequest,
  nextSelect,
  requireAuthMock,
  resetTicketRouteMocks,
  selectMock,
  isEventOrganizerMock,
  itReturns401WhenAuthFails,
  logMock,
} from './support/ticket-route-support';
import { GET } from '../../app/api/events/[id]/tickets/[ticketId]/registration-status/route';

const ATTENDEE_DID = 'did:imajin:attendee';

const BASE_TICKET = {
  id: TICKET_ID,
  ticketTypeId: 'tkt_type_1',
  ownerDid: ATTENDEE_DID,
  registrationStatus: 'complete',
};

const callStatus = () => GET(makeTicketRequest('registration-status', 'GET'), ROUTE_PARAMS);

describe('GET /api/events/[id]/tickets/[ticketId]/registration-status', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callStatus);

  it('returns 404 when ticket is not found', async () => {
    nextSelect([]);

    const res = await callStatus();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: ERR_TICKET_NOT_FOUND });
  });

  it('returns 403 when caller is neither the ticket owner nor an organizer', async () => {
    nextSelect([{ ...BASE_TICKET, ownerDid: 'did:imajin:someone-else' }]);
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await callStatus();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(selectMock).toHaveBeenCalledOnce(); // ticket type never loaded
  });

  it('returns 200 when caller is the ticket owner (not an organizer)', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: ATTENDEE_DID, scopes: [], via: 'token' } });
    isEventOrganizerMock.mockResolvedValue({ authorized: false });
    nextSelect([BASE_TICKET]); // (1) ticket
    nextSelect([{ registrationFormId: 'form_abc' }]); // (2) ticket type

    const res = await callStatus();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'complete', ticketId: TICKET_ID, surveyId: 'form_abc' });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, ATTENDEE_DID, expect.any(Request));
  });

  it('returns 200 when caller is an organizer (not the owner)', async () => {
    nextSelect([BASE_TICKET]); // (1) ticket
    nextSelect([{ registrationFormId: null }]); // (2) ticket type — no form

    const res = await callStatus();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('complete');
    expect(body.surveyId).toBeNull();
  });

  it('returns a null surveyId when the ticket type row is missing', async () => {
    nextSelect([BASE_TICKET]);
    nextSelect([]);

    const res = await callStatus();

    expect(res.status).toBe(200);
    expect((await res.json()).surveyId).toBeNull();
  });

  it('defaults status to "not_required" when registrationStatus is null', async () => {
    nextSelect([{ ...BASE_TICKET, registrationStatus: null }]);
    nextSelect([{ registrationFormId: null }]);

    const res = await callStatus();

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('not_required');
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await callStatus();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch registration status' });
    expect(logMock.error).toHaveBeenCalled();
  });
});
