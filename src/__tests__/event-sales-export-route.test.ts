/**
 * Tests for app/api/events/[id]/sales/export/route.ts
 *
 * Kernel parity (#1998): buyer name/handle/email come from ONE batched
 * `resolveProfiles` call for all buyer DIDs (the kernel's
 * `/profile/api/resolve`), not a per-DID lookup fallback.
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
  testReturns401WhenAuthFails,
  testReturns403ForNonOrganizer,
  testReturns404WhenEventNotFound,
  testReturns500OnUnexpectedError,
} from './support/resolve-route-test-support';

import { GET } from '../../app/api/events/[id]/sales/export/route';

const makeRequest = (query = '') => makeEventRequest('sales/export', query);

const EVENT_ROW = { id: EVENT_ID, title: 'Test Event' };

const ORDER_ROW = {
  order_id: 'ord_1',
  buyer_did: BUYER_DID,
  quantity: 1,
  amount_total: 5000,
  currency: 'CAD',
  payment_method: 'stripe',
  stripe_session_id: 'cs_1',
  payment_id: 'pi_1',
  purchased_at: '2026-01-02T10:00:00.000Z',
  ticket_type: 'General',
};

const TICKET_ROW = { id: 'tkt_1', status: 'valid', order_id: 'ord_1' };

/** Parse the CSV body (BOM stripped) into header + first data row. */
function parseCsv(text: string): { header: string[]; row: string[] } {
  const [header, row] = text.replace('\uFEFF', '').split('\r\n');
  return { header: header.split(','), row: (row ?? '').split(',') };
}

beforeEach(resetResolveRouteMocks);

describe('GET .../sales/export — batched identity resolution (#1998)', () => {
  it('resolves buyer identities in one batched call and includes them in the CSV', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([TICKET_ROW]);
    resolveProfilesMock.mockResolvedValue(
      profileMap(profile(BUYER_DID, 'Buyer Name', 'buyer-handle', 'buyer@example.com')),
    );

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const text = await res.text();

    expect(res.status).toBe(200);
    expectOrganizerCheckedFor();
    expect(resolveProfilesMock).toHaveBeenCalledTimes(1);
    expect(resolveProfilesMock).toHaveBeenCalledWith([BUYER_DID]);

    const { header, row } = parseCsv(text);
    expect(header.slice(0, 5)).toEqual(['Order ID', 'Buyer Name', 'Buyer Handle', 'Buyer Email', 'Buyer DID']);
    expect(row.slice(0, 5)).toEqual(['ord_1', 'Buyer Name', 'buyer-handle', 'buyer@example.com', BUYER_DID]);
    expect(row).toContain('completed'); // computeOrderStatus: valid ticket -> completed
    expect(row).toContain('50'); // amount_total is exported in dollars
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/test-event-sales-\d{4}-\d{2}-\d{2}\.csv/);
  });

  it('emits blank buyer fields and an unknown status when nothing resolves', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([]); // no tickets -> computeOrderStatus 'unknown'

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const { row } = parseCsv(await res.text());

    expect(res.status).toBe(200);
    expect(row.slice(0, 5)).toEqual(['ord_1', '', '', '', BUYER_DID]);
    expect(row).toContain('unknown');
  });

  it('uses the xlsx content type and filename extension when format=xlsx', async () => {
    nextSql([EVENT_ROW]);
    nextSql([]); // no orders
    nextSql([]); // no tickets

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
