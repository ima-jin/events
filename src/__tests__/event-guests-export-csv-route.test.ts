/**
 * Tests for app/api/events/[id]/guests/export.csv/route.ts
 *
 * Kernel parity (#1998): owner/buyer identities resolve in ONE batched
 * `resolveProfiles` call (the kernel's `/profile/api/resolve`). Survey
 * answers/forms come from dykil's public API (`@/lib/surveys`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUYER_DID,
  EVENT_ID,
  OWNER_DID,
  ROUTE_PARAMS,
  expectOrganizerCheckedFor,
  getSurveyFormsMock,
  getSurveyResponsesForTicketsMock,
  makeEventRequest,
  nextSql,
  profile,
  profileMap,
  resetResolveRouteMocks,
  resolveProfilesMock,
  surveyMap,
  testReturns401WhenAuthFails,
  testReturns403ForNonOrganizer,
  testReturns404WhenEventNotFound,
  testReturns500OnUnexpectedError,
} from './support/resolve-route-test-support';

import { GET } from '../../app/api/events/[id]/guests/export.csv/route';

const makeRequest = (query = '') => makeEventRequest('guests/export.csv', query);

const EVENT_ROW = { id: EVENT_ID, title: 'Test Event' };

const TICKET_ROW = {
  id: 'tkt_1',
  status: 'valid',
  owner_did: OWNER_DID,
  purchased_at: '2026-01-02T10:00:00.000Z',
  payment_method: 'stripe',
  ticket_payment_id: 'pi_1',
  payment_confirmed_at: null,
  registration_status: 'complete',
  order_id: 'ord_1',
  ticket_type: 'General',
  registration_form_id: null,
  order_payment_id: null,
  stripe_session_id: null,
  buyer_email: null,
  buyer_did: BUYER_DID,
};

const OWNER_PROFILE = profile(OWNER_DID, 'Owner Name', 'owner-handle', 'owner@example.com');
const BUYER_PROFILE = profile(BUYER_DID, 'Buyer Name', 'buyer-handle', 'buyer@example.com');

beforeEach(resetResolveRouteMocks);

describe('GET .../guests/export.csv — batched identity resolution (#1998)', () => {
  it('resolves owner and buyer DIDs in a single batched call and includes them in the CSV', async () => {
    nextSql([EVENT_ROW]);
    nextSql([TICKET_ROW]);
    resolveProfilesMock.mockResolvedValue(profileMap(OWNER_PROFILE, BUYER_PROFILE));

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const text = await res.text();

    expect(res.status).toBe(200);
    expectOrganizerCheckedFor();
    expect(resolveProfilesMock).toHaveBeenCalledTimes(1);
    expect(new Set(resolveProfilesMock.mock.calls[0][0])).toEqual(new Set([OWNER_DID, BUYER_DID]));
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/test-event-guests-\d{4}-\d{2}-\d{2}\.csv/);
    expect(text).toContain('Owner Name');
    expect(text).toContain('owner@example.com');
    expect(text).toContain('stripe / paid');
  });

  it('falls back to the buyer identity when the owner does not resolve', async () => {
    nextSql([EVENT_ROW]);
    nextSql([TICKET_ROW]);
    resolveProfilesMock.mockResolvedValue(profileMap(BUYER_PROFILE));

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const text = await res.text();

    expect(text).toContain('Buyer Name');
  });

  it('adds one Survey column per dykil form field and fills it from the ticket response', async () => {
    nextSql([EVENT_ROW]);
    nextSql([{ ...TICKET_ROW, registration_form_id: 'form_1' }]);
    getSurveyResponsesForTicketsMock.mockResolvedValue(
      surveyMap({ tkt_1: { full_name: 'Survey Name', diet: 'vegan' } }),
    );
    getSurveyFormsMock.mockResolvedValue(
      new Map([['form_1', { id: 'form_1', fields: [{ name: 'diet', title: 'Dietary needs' }] }]]),
    );

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const [header, row] = (await res.text()).replace('\uFEFF', '').split('\r\n');

    expect(getSurveyFormsMock).toHaveBeenCalledWith(['form_1']);
    expect(header).toContain('Survey: Dietary needs');
    expect(row).toContain('Survey Name');
    expect(row).toContain('vegan');
  });

  it('lists cancelled tickets with their status when includeCancelled=1', async () => {
    nextSql([EVENT_ROW]);
    nextSql([{ ...TICKET_ROW, status: 'cancelled' }]);

    const res = await GET(makeRequest('?includeCancelled=1'), ROUTE_PARAMS);
    const [, row] = (await res.text()).replace('\uFEFF', '').split('\r\n');

    expect(res.status).toBe(200);
    expect(row).toContain('cancelled');
    expect(row).toContain('stripe / cancelled');
  });

  it('returns a JSON summary when summary=1 without resolving identities', async () => {
    nextSql([EVENT_ROW]);
    nextSql([
      { ...TICKET_ROW, status: 'cancelled' },
      { ...TICKET_ROW, id: 'tkt_2', registration_status: 'pending' },
    ]);

    const res = await GET(makeRequest('?summary=1'), ROUTE_PARAMS);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      total: 2,
      valid: 1,
      pendingRegistration: 1,
      completeRegistration: 1,
      cancelled: 1,
    });
    expect(resolveProfilesMock).not.toHaveBeenCalled();
  });

  testReturns404WhenEventNotFound(GET, makeRequest);
  testReturns403ForNonOrganizer(GET, makeRequest);
  testReturns401WhenAuthFails(GET, makeRequest);
  testReturns500OnUnexpectedError(GET, makeRequest);
});
