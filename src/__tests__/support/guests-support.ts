/**
 * Shared fixtures + mock builders for the guests service / repository suites.
 * Pure helpers only: each suite registers its own `vi.mock` calls.
 */
import { vi } from 'vitest';
import type {
  AttendingEventRow,
  GuestExportRow,
  GuestTicketRow,
} from '@/repositories/guests-repository';

export const EVENT_ID = 'evt_1';
export const ORGANIZER_DID = 'did:imajin:organizer';
export const OWNER_DID = 'did:imajin:owner';
export const BUYER_DID = 'did:imajin:buyer';

export function ticketRow(overrides: Partial<GuestTicketRow> = {}): GuestTicketRow {
  return {
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
    registration_form_id: null,
    fair_settlement: null,
    amount_total: 5000,
    buyer_email: null,
    buyer_did: BUYER_DID,
    ...overrides,
  };
}

export function exportRow(overrides: Partial<GuestExportRow> = {}): GuestExportRow {
  return {
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
    ...overrides,
  };
}

export function attendingRow(eventId: string, overrides: Partial<AttendingEventRow> = {}): AttendingEventRow {
  return {
    eventId,
    title: `Event ${eventId}`,
    startsAt: new Date('2026-12-01T20:00:00.000Z'),
    endsAt: null,
    venue: null,
    accessMode: 'public',
    imageUrl: null,
    ...overrides,
  };
}

/** A resolved kernel profile as returned by `resolveProfiles`. */
export function profile(did: string, displayName: string, handle: string, email?: string) {
  return { did, displayName, handle, ...(email ? { email } : {}) };
}

/** `resolveProfiles` result map from a list of profiles. */
export function profileMap(...profiles: ReturnType<typeof profile>[]) {
  return new Map(profiles.map((p) => [p.did, p]));
}

/** Survey responses map as returned by `getSurveyResponsesForTickets`. */
export function surveyMap(entries: Record<string, Record<string, unknown>>) {
  return new Map(
    Object.entries(entries).map(([ticketId, answers]) => [
      ticketId,
      { id: `resp_${ticketId}`, surveyId: 'form_1', answers },
    ]),
  );
}

/** A drizzle query-builder double: every builder method returns itself and awaiting yields `result`. */
export function drizzleChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

/**
 * A postgres.js tagged-template double. Real queries consume queued results in
 * order; value-less templates (conditional fragments) return a marker without
 * consuming the queue. `calls` records the SQL text of each real query.
 */
export function createSqlMock() {
  const queue: unknown[][] = [];
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (values.length === 0) return { fragment: strings.join('') };
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.shift() ?? []);
  });
  return {
    sql,
    calls,
    queue: (rows: unknown[]) => queue.push(rows),
    reset: () => {
      queue.length = 0;
      calls.length = 0;
      sql.mockClear();
    },
  };
}
