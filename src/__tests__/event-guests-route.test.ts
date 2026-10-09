/**
 * Tests for app/api/events/[id]/guests/route.ts
 *
 * Kernel parity (#1998): the route runs a plain ticket query and resolves
 * owner/buyer identities in ONE batched `resolveProfiles` call (the kernel's
 * `/profile/api/resolve`). Survey answers come from dykil's public API.
 * Callers authenticate with a scoped app token / session (`requireAuth`) or,
 * when `x-app-did` is present, the app-auth path (`requireAppAuth`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUYER_DID,
  OWNER_DID,
  ROUTE_PARAMS,
  expectOrganizerCheckedFor,
  getSurveyResponsesForTicketsMock,
  isEventOrganizerMock,
  makeEventRequest,
  nextSql,
  profile,
  profileMap,
  requireAppAuthMock,
  requireAuthMock,
  resetResolveRouteMocks,
  resolveProfilesMock,
  surveyMap,
  testReturns401WhenAuthFails,
  testReturns403ForNonOrganizer,
  testReturns500OnUnexpectedError,
} from './support/resolve-route-test-support';
import { appAuthSuccess } from './support/route-test-support';

import { GET } from '../../app/api/events/[id]/guests/route';

const makeRequest = () => makeEventRequest('guests');

const TICKET_ROW = {
  id: 'tkt_1',
  status: 'valid',
  owner_did: OWNER_DID,
  price_paid: 5000,
  currency: 'CAD',
  purchased_at: '2026-01-02T10:00:00.000Z',
  used_at: null,
  payment_method: 'stripe',
  payment_id: 'pi_1',
  hold_expires_at: null,
  registration_status: 'complete',
  last_email_sent_at: null,
  ticket_type: 'General',
  registration_form_id: 'form_1',
  fair_settlement: null,
  amount_total: 5000,
  buyer_email: null,
  buyer_did: BUYER_DID,
};

beforeEach(resetResolveRouteMocks);

describe('GET .../guests — batched identity resolution (#1998)', () => {
  it('resolves owner and buyer DIDs in a single batched call', async () => {
    nextSql([TICKET_ROW]);

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    expectOrganizerCheckedFor();
    expect(resolveProfilesMock).toHaveBeenCalledTimes(1);
    const requestedDids = resolveProfilesMock.mock.calls[0][0] as string[];
    expect(new Set(requestedDids)).toEqual(new Set([OWNER_DID, BUYER_DID]));
  });

  it('populates guest profile/email from the resolved map, not raw SQL columns', async () => {
    nextSql([TICKET_ROW]);
    resolveProfilesMock.mockResolvedValue(
      profileMap(
        profile(OWNER_DID, 'Owner Name', 'owner-handle', 'owner@example.com'),
        profile(BUYER_DID, 'Buyer Name', 'buyer-handle'),
      ),
    );

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(json.isOwner).toBe(true);
    expect(json.guests).toHaveLength(1);
    expect(json.guests[0].profile).toEqual({
      name: 'Owner Name',
      handle: 'owner-handle',
      avatar: null,
      email: 'owner@example.com',
    });
    expect(json.guests[0].resolvedName).toBe('Owner Name');
    expect(json.guests[0].resolvedEmail).toBe('owner@example.com');
  });

  it('prefers the dykil survey answers for the attendee name and email', async () => {
    nextSql([TICKET_ROW]);
    getSurveyResponsesForTicketsMock.mockResolvedValue(
      surveyMap({ tkt_1: { full_name: 'Survey Name', email: 'survey@example.com' } }),
    );
    resolveProfilesMock.mockResolvedValue(profileMap(profile(OWNER_DID, 'Owner Name', 'owner-handle', 'owner@example.com')));

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(getSurveyResponsesForTicketsMock).toHaveBeenCalledWith([{ ticketId: 'tkt_1', formId: 'form_1' }]);
    expect(json.guests[0]).toMatchObject({
      attendeeName: 'Survey Name',
      resolvedName: 'Survey Name',
      resolvedEmail: 'survey@example.com',
    });
  });

  it('returns null profile for a ticket with no owner DID and skips resolution for it', async () => {
    nextSql([{ ...TICKET_ROW, owner_did: null, buyer_did: null }]);

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(json.guests[0].profile).toBeNull();
    expect(resolveProfilesMock).toHaveBeenCalledWith([]);
  });

  it('authenticates via app auth when x-app-did is present and checks the organizer for its user', async () => {
    nextSql([TICKET_ROW]);
    requireAppAuthMock.mockResolvedValue(appAuthSuccess('did:imajin:app-user'));
    const request = makeEventRequest('guests');
    request.headers.set('x-app-did', 'did:imajin:app');

    const res = await GET(request, ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(requireAppAuthMock).toHaveBeenCalledWith(request, { scope: 'events:read' });
    expect(requireAuthMock).not.toHaveBeenCalled();
    expectOrganizerCheckedFor('did:imajin:app-user');
  });

  it('returns the app-auth error status when the app token is rejected', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'Insufficient scope', status: 403 });
    const request = makeEventRequest('guests');
    request.headers.set('x-app-did', 'did:imajin:app');

    const res = await GET(request, ROUTE_PARAMS);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient scope' });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  testReturns403ForNonOrganizer(GET, makeRequest);
  testReturns401WhenAuthFails(GET, makeRequest);
  testReturns500OnUnexpectedError(GET, makeRequest);
});
