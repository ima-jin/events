/**
 * Tests for app/api/events/[id]/sales/route.ts
 *
 * Kernel parity (#1998): buyer and orphan-ticket-owner identity is resolved
 * through ONE batched `resolveProfiles` call each (the kernel's
 * `/profile/api/resolve`), never a per-DID lookup or a raw `auth.*` join.
 * Attendee names come from dykil's public survey API (`@/lib/surveys`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUYER_DID,
  EVENT_ID,
  ROUTE_PARAMS,
  expectOrganizerCheckedFor,
  makeEventRequest,
  nextSql,
  profile,
  profileMap,
  resetResolveRouteMocks,
  resolveProfilesMock,
  getSurveyResponsesForTicketsMock,
  surveyMap,
  testReturns401WhenAuthFails,
  testReturns403ForNonOrganizer,
  testReturns404WhenEventNotFound,
  testReturns500OnUnexpectedError,
} from './support/resolve-route-test-support';

import { GET } from '../../app/api/events/[id]/sales/route';

const makeRequest = (query = '') => makeEventRequest('sales', query);

const EVENT_ROW = { id: EVENT_ID, title: 'Test Event', currency: 'CAD' };
const ORPHAN_OWNER_DID = 'did:imajin:orphan-owner';

const ORDER_ROW = {
  order_id: 'ord_1',
  buyer_did: BUYER_DID,
  amount_total: 5000,
  currency: 'CAD',
  order_status: 'completed',
  payment_method: 'stripe',
  stripe_session_id: 'cs_1',
  purchased_at: '2026-01-02T10:00:00.000Z',
  created_at: '2026-01-01T10:00:00.000Z',
  ticket_id: 'tkt_1',
  ticket_status: 'valid',
  ticket_type_name: 'General',
  registration_form_id: 'form_1',
};

const ORPHAN_ROW = {
  ticket_id: 'tkt_orphan',
  status: 'valid',
  owner_did: ORPHAN_OWNER_DID,
  price_paid: 2500,
  currency: 'CAD',
  purchased_at: '2026-01-03T10:00:00.000Z',
  payment_method: 'etransfer',
  payment_id: null,
  ticket_type_name: 'General',
  registration_form_id: 'form_1',
};

const BUYER_PROFILE = profile(BUYER_DID, 'Buyer Name', 'buyer-handle', 'buyer@example.com');
const ORPHAN_PROFILE = profile(ORPHAN_OWNER_DID, 'Orphan Owner', 'orphan-handle', 'owner@example.com');

type SaleView = { orderId: string; [key: string]: unknown };

function findSale(json: { sales: SaleView[] }, orderId: string): SaleView | undefined {
  return json.sales.find((s) => s.orderId === orderId);
}

beforeEach(resetResolveRouteMocks);

describe('GET .../sales — batched identity resolution (#1998)', () => {
  it('resolves buyer and orphan-owner DIDs via resolveProfiles and returns JSON', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([ORPHAN_ROW]);
    resolveProfilesMock
      .mockResolvedValueOnce(profileMap(BUYER_PROFILE))
      .mockResolvedValueOnce(profileMap(ORPHAN_PROFILE));

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(res.status).toBe(200);
    expectOrganizerCheckedFor();
    expect(resolveProfilesMock).toHaveBeenNthCalledWith(1, [BUYER_DID]);
    expect(resolveProfilesMock).toHaveBeenNthCalledWith(2, [ORPHAN_OWNER_DID]);

    expect(findSale(json, 'ord_1')).toMatchObject({
      buyerDid: BUYER_DID,
      buyerName: 'Buyer Name',
      buyerHandle: 'buyer-handle',
      buyerEmail: 'buyer@example.com',
      amountTotal: 5000,
      status: 'completed',
      // gap(kernel): no public per-order pay route, so no payment id on order sales.
      paymentId: null,
    });
    expect(findSale(json, 'tkt_orphan')).toMatchObject({
      buyerName: 'Orphan Owner',
      buyerHandle: 'orphan-handle',
      buyerEmail: 'owner@example.com',
      amountTotal: 2500,
      status: 'completed',
    });
    expect(json.summary).toMatchObject({ totalSales: 2, totalRevenue: 7500, avgOrderValue: 3750 });
  });

  it('orders the unified sales list newest first', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([ORPHAN_ROW]);

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(json.sales.map((s: SaleView) => s.orderId)).toEqual(['tkt_orphan', 'ord_1']);
  });

  it('falls back to the survey attendee name when no identity resolves for the orphan owner', async () => {
    nextSql([EVENT_ROW]);
    nextSql([]); // no orders
    nextSql([ORPHAN_ROW]);
    getSurveyResponsesForTicketsMock
      .mockResolvedValueOnce(new Map()) // order tickets (none)
      .mockResolvedValueOnce(surveyMap({ tkt_orphan: { full_name: 'Orphan Attendee', email: 'orphan@example.com' } }));

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const orphanSale = findSale(await res.json(), 'tkt_orphan');

    expect(orphanSale?.buyerName).toBe('Orphan Attendee');
    expect(orphanSale?.buyerHandle).toBeNull();
    expect(orphanSale?.buyerEmail).toBeNull();
  });

  it('requests no survey answers for orders that have no ticket rows yet', async () => {
    nextSql([EVENT_ROW]);
    nextSql([{ ...ORDER_ROW, ticket_id: null }]);
    nextSql([]);

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(getSurveyResponsesForTicketsMock).toHaveBeenNthCalledWith(1, []);
    expect(findSale(json, 'ord_1')).toMatchObject({ quantity: 0, status: 'unknown' });
  });

  it('returns a CSV download when format=csv is requested', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([]); // no orphans
    resolveProfilesMock.mockResolvedValueOnce(profileMap(BUYER_PROFILE));

    const res = await GET(makeRequest('?format=csv'), ROUTE_PARAMS);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(/test-event-sales-\d{4}-\d{2}-\d{2}\.csv/);
    expect(text).toContain('Buyer Name');
    expect(text).toContain('buyer-handle');
    expect(text).toContain('General (1)');
  });

  it('uses the spreadsheet content type and .xlsx filename when format=xlsx', async () => {
    nextSql([EVENT_ROW]);
    nextSql([]);
    nextSql([]);

    const res = await GET(makeRequest('?format=xlsx'), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml');
    expect(res.headers.get('Content-Disposition')).toContain('.xlsx');
  });

  testReturns404WhenEventNotFound(GET, makeRequest);
  testReturns403ForNonOrganizer(GET, makeRequest);
  testReturns401WhenAuthFails(GET, makeRequest);
  testReturns500OnUnexpectedError(GET, makeRequest);
});
