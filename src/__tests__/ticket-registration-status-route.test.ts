/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/registration-status/route.ts
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
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mocks, nextDrizzleSelect, resetRouteMocks, ticketRequest, TICKET_ROUTE_PARAMS, testReturns401WhenAuthFails } from './support/route-test-support';

// ─── Subject ────────────────────────────────────────────────────────────────

import { GET } from '../../app/api/events/[id]/tickets/[ticketId]/registration-status/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeRequest = () => ticketRequest('registration-status', 'GET');

const BASE_TICKET = {
  id: 'tkt_1',
  ticketTypeId: 'tkt_type_1',
  ownerDid: 'did:imajin:attendee',
  registrationStatus: 'complete',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/events/[id]/tickets/[ticketId]/registration-status', () => {
  beforeEach(() => {
    resetRouteMocks();
  });

  testReturns401WhenAuthFails(GET, makeRequest);

  it('returns 404 when ticket is not found', async () => {
    nextDrizzleSelect([]);
    const res = await GET(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 403 when caller is neither the ticket owner nor an organizer', async () => {
    // Ticket owner is someone else, and caller is not an organizer
    nextDrizzleSelect([{ ...BASE_TICKET, ownerDid: 'did:imajin:someone-else' }]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await GET(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(403);
  });

  it('returns 200 when caller is the ticket owner (not an organizer)', async () => {
    // Caller is the owner — requireAuth returns the attendee DID
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:attendee', actingAs: null },
    });
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });

    nextDrizzleSelect([BASE_TICKET]);                                      // (1) ticket
    nextDrizzleSelect([{ registrationFormId: 'form_abc' }]);              // (2) ticket type

    const res = await GET(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('complete');
    expect(body.surveyId).toBe('form_abc');
    expect(body.ticketId).toBe('tkt_1');
  });

  it('returns 200 when caller is an organizer (not the owner)', async () => {
    // Caller is organizer, not the ticket owner
    nextDrizzleSelect([BASE_TICKET]);                                      // (1) ticket
    nextDrizzleSelect([{ registrationFormId: null }]);                    // (2) ticket type — no form

    const res = await GET(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('complete');
    expect(body.surveyId).toBeNull();
  });

  it('defaults status to "not_required" when registrationStatus is null', async () => {
    nextDrizzleSelect([{ ...BASE_TICKET, registrationStatus: null }]);    // (1) ticket
    nextDrizzleSelect([{ registrationFormId: null }]);                    // (2) ticket type

    const res = await GET(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('not_required');
  });
});
