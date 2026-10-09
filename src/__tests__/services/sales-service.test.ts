import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUYER_DID,
  COOKIE,
  csvLines,
  EVENT_ID,
  exportOrderRow,
  ORGANIZER_DID,
  orderSaleRow,
  orphanRow,
  ORPHAN_OWNER_DID,
  profile,
  profileMap,
  salesEvent,
  surveyMap,
  thrown,
  ticketStatusRow,
} from '../support/sales-support';

const mocks = vi.hoisted(() => ({
  isEventOrganizer: vi.fn(),
  resolveProfiles: vi.fn(),
  getSurveyResponsesForTickets: vi.fn(),
  getSurveyForms: vi.fn(),
  repo: {
    getSalesEvent: vi.fn(),
    listExportOrderRows: vi.fn(),
    listOrderSaleRows: vi.fn(),
    listOrphanTicketRows: vi.fn(),
    listTicketStatusRows: vi.fn(),
  },
}));

vi.mock('@/services/authorization', () => ({ isEventOrganizer: mocks.isEventOrganizer }));
vi.mock('@/repositories/sales-repository', () => mocks.repo);
vi.mock('@/lib/kernel', () => ({ resolveProfiles: mocks.resolveProfiles }));
vi.mock('@/lib/surveys', () => ({
  getSurveyResponsesForTickets: mocks.getSurveyResponsesForTickets,
  getSurveyForms: mocks.getSurveyForms,
}));

import { computeOrderStatus, exportEventSales, getEventSales } from '@/services/sales-service';

const BUYER_PROFILE = profile(BUYER_DID, 'Buyer Name', 'buyer-handle', 'buyer@example.com');
const ORPHAN_PROFILE = profile(ORPHAN_OWNER_DID, 'Orphan Owner', 'orphan-handle', 'owner@example.com');

async function jsonReport(options: Parameters<typeof getEventSales>[2] = {}) {
  const result = await getEventSales(EVENT_ID, ORGANIZER_DID, options);
  if (result.kind !== 'json') throw new Error('expected the JSON report');
  return result.report;
}

async function csvFile(options: Parameters<typeof getEventSales>[2]) {
  const result = await getEventSales(EVENT_ID, ORGANIZER_DID, options);
  if (result.kind !== 'file') throw new Error('expected a file');
  return result.file;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isEventOrganizer.mockResolvedValue({ authorized: true, role: 'creator' });
  mocks.resolveProfiles.mockResolvedValue(new Map());
  mocks.getSurveyResponsesForTickets.mockResolvedValue(new Map());
  mocks.repo.getSalesEvent.mockResolvedValue(salesEvent());
  mocks.repo.listOrderSaleRows.mockResolvedValue([]);
  mocks.repo.listOrphanTicketRows.mockResolvedValue([]);
  mocks.repo.listExportOrderRows.mockResolvedValue([]);
  mocks.repo.listTicketStatusRows.mockResolvedValue([]);
});

describe.each([
  ['getEventSales', () => getEventSales(EVENT_ID, ORGANIZER_DID, { callerCookie: COOKIE })],
  ['exportEventSales', () => exportEventSales(EVENT_ID, ORGANIZER_DID, { callerCookie: COOKIE })],
])('%s authorization', (_name, call) => {
  it('rejects a non-organizer with the kernel 403 before touching any data', async () => {
    mocks.isEventOrganizer.mockResolvedValue({ authorized: false });

    expect(await thrown(call())).toMatchObject({ code: 'forbidden', status: 403, message: 'Forbidden' });
    expect(mocks.isEventOrganizer).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, COOKIE);
    expect(mocks.repo.getSalesEvent).not.toHaveBeenCalled();
    expect(mocks.resolveProfiles).not.toHaveBeenCalled();
  });

  it('answers 404 when the event does not exist', async () => {
    mocks.repo.getSalesEvent.mockResolvedValue(null);

    expect(await thrown(call())).toMatchObject({ code: 'not_found', status: 404, message: 'Event not found' });
    expect(mocks.resolveProfiles).not.toHaveBeenCalled();
  });
});

describe('getEventSales JSON report', () => {
  it('merges orders and orphan tickets newest first, resolving each batch of DIDs once', async () => {
    mocks.repo.listOrderSaleRows.mockResolvedValue([orderSaleRow()]);
    mocks.repo.listOrphanTicketRows.mockResolvedValue([orphanRow()]);
    mocks.resolveProfiles
      .mockResolvedValueOnce(profileMap(BUYER_PROFILE))
      .mockResolvedValueOnce(profileMap(ORPHAN_PROFILE));

    const report = await jsonReport();

    expect(mocks.resolveProfiles).toHaveBeenNthCalledWith(1, [BUYER_DID]);
    expect(mocks.resolveProfiles).toHaveBeenNthCalledWith(2, [ORPHAN_OWNER_DID]);
    expect(report.sales.map((s) => s.orderId)).toEqual(['tkt_orphan', 'ord_1']);
    expect(report.sales[1]).toMatchObject({
      buyerDid: BUYER_DID,
      buyerName: 'Buyer Name',
      buyerHandle: 'buyer-handle',
      buyerEmail: 'buyer@example.com',
      ticketType: 'General',
      quantity: 1,
      amountTotal: 5000,
      currency: 'CAD',
      paymentId: null,
      stripeSessionId: 'cs_1',
      purchasedAt: '2026-01-02T10:00:00.000Z',
      tickets: [{ ticketId: 'tkt_1', status: 'valid' }],
      status: 'completed',
    });
    expect(report.sales[0]).toMatchObject({
      buyerName: 'Orphan Owner',
      buyerEmail: 'owner@example.com',
      amountTotal: 2500,
      status: 'completed',
      quantity: 1,
    });
    expect(report.orphans).toEqual([]);
    expect(report.orphanOrders).toEqual([]);
    expect(report.summary).toEqual({ totalSales: 2, totalRevenue: 7500, avgOrderValue: 3750, totalOrders: 2 });
  });

  it('reports an empty event with a zero average', async () => {
    const report = await jsonReport();

    expect(report.sales).toEqual([]);
    expect(report.summary).toEqual({ totalSales: 0, totalRevenue: 0, avgOrderValue: 0, totalOrders: 0 });
  });

  it('groups an order\'s ticket rows, de-duplicating tickets and counting types', async () => {
    mocks.repo.listOrderSaleRows.mockResolvedValue([
      orderSaleRow({ ticket_id: 'tkt_1' }),
      orderSaleRow({ ticket_id: 'tkt_2', ticket_status: 'used' }),
      orderSaleRow({ ticket_id: 'tkt_2', ticket_status: 'used' }),
      orderSaleRow({ ticket_id: 'tkt_3', ticket_type_name: 'VIP', ticket_status: 'cancelled' }),
    ]);

    const [sale] = (await jsonReport()).sales;

    expect(sale).toMatchObject({ ticketType: 'General (2), VIP', quantity: 3, status: 'partial' });
    expect(sale.tickets.map((t) => t.ticketId)).toEqual(['tkt_1', 'tkt_2', 'tkt_3']);
    expect(mocks.getSurveyResponsesForTickets).toHaveBeenCalledTimes(2);
  });

  it('uses survey attendee names, falling back to the survey name for an unresolved orphan owner', async () => {
    mocks.repo.listOrphanTicketRows.mockResolvedValue([orphanRow()]);
    mocks.getSurveyResponsesForTickets
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(surveyMap({ tkt_orphan: { name: 'Orphan Attendee' } }));

    const [orphan] = (await jsonReport()).sales;

    expect(orphan).toMatchObject({ buyerName: 'Orphan Attendee', buyerHandle: null, buyerEmail: null });
  });

  it('requests no survey answers for an order without tickets, which is unknown with no amount', async () => {
    mocks.repo.listOrderSaleRows.mockResolvedValue([
      orderSaleRow({
        ticket_id: null,
        amount_total: null,
        currency: null,
        purchased_at: null,
        buyer_did: null,
        ticket_status: null,
        ticket_type_name: null,
      }),
    ]);
    mocks.repo.getSalesEvent.mockResolvedValue(salesEvent({ currency: null }));

    const [sale] = (await jsonReport()).sales;

    expect(mocks.getSurveyResponsesForTickets).toHaveBeenNthCalledWith(1, []);
    expect(mocks.resolveProfiles).toHaveBeenNthCalledWith(1, []);
    expect(sale).toMatchObject({
      quantity: 0,
      status: 'unknown',
      ticketType: 'Unknown',
      amountTotal: 0,
      currency: 'USD',
      buyerDid: null,
      purchasedAt: '2026-01-01T10:00:00.000Z',
    });
  });

  it('takes the ticket survey name and defaults for an order ticket with missing columns', async () => {
    mocks.repo.listOrderSaleRows.mockResolvedValue([
      orderSaleRow({ ticket_status: null, ticket_type_name: null, currency: null }),
    ]);
    mocks.getSurveyResponsesForTickets.mockResolvedValueOnce(surveyMap({ tkt_1: { full_name: 'Ada' } }));

    const [sale] = (await jsonReport()).sales;

    expect(sale).toMatchObject({ currency: 'CAD', status: 'unknown', tickets: [{ ticketId: 'tkt_1', status: 'unknown' }] });
  });

  it('maps orphan tickets: non-valid statuses, cs_ payment ids and fallback currency', async () => {
    mocks.repo.listOrphanTicketRows.mockResolvedValue([
      orphanRow({ ticket_id: 'o_1', status: 'refunded', payment_id: 'cs_live_1', currency: null, purchased_at: null }),
      orphanRow({ ticket_id: 'o_2', status: null, payment_id: 'pi_1', price_paid: null, owner_did: null }),
    ]);
    mocks.repo.getSalesEvent.mockResolvedValue(salesEvent({ currency: null }));

    const { sales } = await jsonReport();

    expect(sales.find((s) => s.orderId === 'o_1')).toMatchObject({
      status: 'refunded',
      stripeSessionId: 'cs_live_1',
      paymentId: 'cs_live_1',
      currency: 'CAD',
      purchasedAt: null,
    });
    expect(sales.find((s) => s.orderId === 'o_2')).toMatchObject({
      status: 'unknown',
      stripeSessionId: null,
      amountTotal: 0,
      buyerDid: null,
      ticketType: 'General',
    });
  });

  it.each([
    ['empty', [], 'unknown'],
    ['all valid or used', ['valid', 'used'], 'completed'],
    ['all refunded', ['refunded', 'refunded'], 'refunded'],
    ['all cancelled', ['cancelled'], 'cancelled'],
    ['any held', ['held', 'valid'], 'pending'],
    ['mixed usable', ['valid', 'cancelled'], 'partial'],
    ['nothing usable', ['cancelled', 'refunded'], 'unknown'],
  ])('computes the order status for %s tickets', (_label, statuses, expected) => {
    expect(computeOrderStatus(statuses.map((status) => ({ status })))).toBe(expected);
  });
});

describe('getEventSales downloads', () => {
  it('returns a CSV with one line per order, formatted amounts and grouped ticket types', async () => {
    mocks.repo.listOrderSaleRows.mockResolvedValue([orderSaleRow(), orderSaleRow({ ticket_id: 'tkt_2' })]);
    mocks.resolveProfiles.mockResolvedValueOnce(profileMap(BUYER_PROFILE));

    const file = await csvFile({ format: 'csv' });
    const [header, line] = csvLines(file.content);

    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.filename).toMatch(/^test-event-sales-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.content.startsWith('\uFEFF')).toBe(true);
    expect(header.split(',').slice(0, 3)).toEqual(['Order ID', 'Transaction ID', 'Buyer Name']);
    expect(line).toBe(
      `ord_1,,Buyer Name,buyer-handle,buyer@example.com,${BUYER_DID},General (2),2,50.00,CAD,completed,stripe,2026-01-02T10:00:00.000Z,cs_1`,
    );
    expect(mocks.repo.listOrphanTicketRows).toHaveBeenCalledWith(EVENT_ID);
  });

  it('blanks missing order fields and uses the event id when the title is missing', async () => {
    mocks.repo.getSalesEvent.mockResolvedValue(salesEvent({ title: null }));
    mocks.repo.listOrderSaleRows.mockResolvedValue([
      orderSaleRow({ buyer_did: null, payment_method: null, stripe_session_id: null, ticket_id: null }),
    ]);

    const file = await csvFile({ format: 'csv' });

    expect(file.filename).toMatch(/^evt_1-sales-/);
    expect(csvLines(file.content)[1]).toBe('ord_1,,,,,,,0,50.00,CAD,unknown,,2026-01-02T10:00:00.000Z,');
  });

  it('uses the spreadsheet content type and .xlsx extension for xlsx', async () => {
    const file = await csvFile({ format: 'xlsx' });

    expect(file.contentType).toContain('spreadsheetml');
    expect(file.filename).toMatch(/\.xlsx$/);
  });

  it('falls back to the event id when the title has no usable characters', async () => {
    mocks.repo.getSalesEvent.mockResolvedValue(salesEvent({ title: '***' }));

    expect((await csvFile({ format: 'csv' })).filename).toMatch(/^evt_1-sales-/);
  });

  it('treats an unknown format as the JSON report', async () => {
    expect((await getEventSales(EVENT_ID, ORGANIZER_DID, { format: 'pdf' })).kind).toBe('json');
  });
});

describe('exportEventSales', () => {
  it('exports one line per order with its buyer, status and ticket ids/statuses', async () => {
    mocks.repo.listExportOrderRows.mockResolvedValue([exportOrderRow()]);
    mocks.repo.listTicketStatusRows.mockResolvedValue([
      ticketStatusRow(),
      ticketStatusRow({ id: 'tkt_2', status: 'used' }),
      ticketStatusRow({ id: 'tkt_x', order_id: null }),
    ]);
    mocks.resolveProfiles.mockResolvedValue(profileMap(BUYER_PROFILE));

    const file = await exportEventSales(EVENT_ID, ORGANIZER_DID, { callerCookie: COOKIE });
    const [header, line] = csvLines(file.content);

    expect(mocks.resolveProfiles).toHaveBeenCalledTimes(1);
    expect(mocks.resolveProfiles).toHaveBeenCalledWith([BUYER_DID]);
    expect(header.split(',').slice(0, 5)).toEqual(['Order ID', 'Buyer Name', 'Buyer Handle', 'Buyer Email', 'Buyer DID']);
    expect(line).toBe(
      `ord_1,Buyer Name,buyer-handle,buyer@example.com,${BUYER_DID},General,1,50,CAD,completed,stripe,cs_1,pi_1,2026-01-02T10:00:00.000Z,tkt_1; tkt_2,valid; used`,
    );
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.filename).toMatch(/^test-event-sales-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('emits blank buyer/payment fields, CAD and an unknown status when nothing resolves', async () => {
    mocks.repo.listExportOrderRows.mockResolvedValue([
      exportOrderRow({ currency: null, payment_method: null, stripe_session_id: null, payment_id: null, purchased_at: null }),
    ]);

    const [, line] = csvLines((await exportEventSales(EVENT_ID, ORGANIZER_DID)).content);

    expect(line).toBe(`ord_1,,,,${BUYER_DID},General,1,50,CAD,unknown,,,,,,`);
  });

  it('uses the xlsx content type and extension when format=xlsx', async () => {
    const file = await exportEventSales(EVENT_ID, ORGANIZER_DID, { format: 'xlsx' });

    expect(file.contentType).toContain('spreadsheetml');
    expect(file.filename).toMatch(/\.xlsx$/);
  });
});
