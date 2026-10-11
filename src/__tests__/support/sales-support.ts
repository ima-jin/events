/**
 * Shared fixtures + helpers for the sales / admin-export service and repository
 * suites. Pure helpers only: each suite registers its own `vi.mock` calls.
 */
import type {
  AdminEventRow,
  ExportOrderRow,
  OrderSaleRow,
  OrphanTicketRow,
  SalesEventRow,
  TicketStatusRow,
} from '@/repositories/sales-repository';
import { BUYER_DID, createSqlMock, EVENT_ID, ORGANIZER_DID, profile, profileMap, surveyMap } from './guests-support';

export { BUYER_DID, createSqlMock, EVENT_ID, ORGANIZER_DID, profile, profileMap, surveyMap };

export const ORPHAN_OWNER_DID = 'did:imajin:orphan-owner';
export const COOKIE = 'session=abc';

export function salesEvent(overrides: Partial<SalesEventRow> = {}): SalesEventRow {
  return { id: 'evt_1', title: 'Test Event', currency: 'CAD', ...overrides };
}

export function orderSaleRow(overrides: Partial<OrderSaleRow> = {}): OrderSaleRow {
  return {
    order_id: 'ord_1',
    buyer_did: BUYER_DID,
    amount_total: 5000,
    currency: 'CAD',
    payment_method: 'stripe',
    stripe_session_id: 'cs_1',
    purchased_at: '2026-01-02T10:00:00.000Z',
    created_at: '2026-01-01T10:00:00.000Z',
    ticket_id: 'tkt_1',
    ticket_status: 'valid',
    ticket_type_name: 'General',
    registration_form_id: 'form_1',
    ...overrides,
  };
}

export function orphanRow(overrides: Partial<OrphanTicketRow> = {}): OrphanTicketRow {
  return {
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
    ...overrides,
  };
}

export function exportOrderRow(overrides: Partial<ExportOrderRow> = {}): ExportOrderRow {
  return {
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
    ...overrides,
  };
}

export function ticketStatusRow(overrides: Partial<TicketStatusRow> = {}): TicketStatusRow {
  return { id: 'tkt_1', status: 'valid', order_id: 'ord_1', ...overrides };
}

export function adminEventRow(overrides: Partial<AdminEventRow> = {}): AdminEventRow {
  return {
    id: 'evt_1',
    title: 'Gala',
    status: 'published',
    starts_at: '2026-06-01T20:00:00.000Z',
    ends_at: new Date('2026-06-01T23:00:00.000Z'),
    city: 'Toronto',
    creator_did: 'did:imajin:creator',
    ticket_type_count: '2',
    tickets_sold: '10',
    tickets_used: '4',
    total_revenue: '50000',
    currency: 'CAD',
    has_registration_form: true,
    surveys_completed: '3',
    ...overrides,
  };
}

/** The service error a call rejected with (fails the test when it resolves). */
export async function thrown(promise: Promise<unknown>): Promise<Error & { code?: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string; status?: number };
  }
  throw new Error('expected the call to throw');
}

/** CSV text (BOM stripped) split into its lines (the trailing CRLF yields a final empty entry). */
export function csvLines(content: string): string[] {
  return content.replace('\uFEFF', '').split('\r\n');
}
