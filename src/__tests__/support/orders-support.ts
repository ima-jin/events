/**
 * Shared test support for the orders domain (`orders-service`,
 * `order-confirmation`, `tickets-service`, `cart-validation`, the ticket
 * helpers and the orders / tickets / ticket-types repositories).
 *
 * Three groups:
 *  - module-mock factories for `vi.mock(path, () => import(...).then(m => m.xMock()))`
 *    so no test file re-declares the same mock boilerplate;
 *  - a Proxy-based drizzle chain mock (`dbMock`) for repository tests;
 *  - row fixtures.
 *
 * This module registers no `vi.mock` itself, so importing it never replaces
 * a module under test.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { vi } from 'vitest';
import type { Event, Order, Ticket, TicketType } from '@/db/schema';

// ─── Constants ─────────────────────────────────────────────────────────────

export const EVENT_ID = 'evt_1';
export const ORDER_ID = 'ord_1';
export const TICKET_ID = 'tkt_1';
export const TYPE_ID = 'type_1';
export const ORGANIZER_DID = 'did:imajin:organizer';
export const BUYER_DID = 'did:imajin:buyer';
export const BUYER_EMAIL = 'buyer@test.com';
export const CREATOR_DID = 'did:imajin:creator';

// ─── Module-mock factories ─────────────────────────────────────────────────

function mockFns<K extends string>(names: readonly K[]): Record<K, ReturnType<typeof vi.fn>> {
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<
    K,
    ReturnType<typeof vi.fn>
  >;
}

export const ordersRepositoryMock = () =>
  mockFns(['findOrderById', 'insertOrder', 'markOrderCompleted', 'markOrderRefunded', 'findEventById']);

export const ticketsRepositoryMock = () =>
  mockFns([
    'findTicketById',
    'findTicketInEvent',
    'findHeldEtransferTicketsByOrder',
    'findRefundableTicketsByOrder',
    'insertTicket',
    'markHeldTicketsValid',
    'markTicketsRefunded',
    'cancelTicketRow',
    'releaseExpiredHolds',
    'loadRefundableTicket',
    'setTicketRefundStatus',
    'findTicketStatus',
    'markRefundSentRow',
  ]);

export const ticketTypesRepositoryMock = () =>
  mockFns(['findTicketTypesByEvent', 'findTicketTypesByIds', 'incrementSold', 'decrementSold']);

/** The one logger double every service-under-test writes to. */
export const logMock = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
export const loggerModuleMock = () => ({ createLogger: () => logMock });

export const publishMock = vi.fn();
export const domainEventsModuleMock = () => ({ publish: publishMock });

/** `isEventOrganizer` double — resolves `{ authorized: true }` after `resetOrdersMocks()`. */
export const isEventOrganizerMock = vi.fn();
export const authorizationModuleMock = () => ({ isEventOrganizer: isEventOrganizerMock });

/** Reset every shared double to its "happy path" default. Call from `beforeEach`. */
export function resetOrdersMocks(): void {
  vi.clearAllMocks();
  publishMock.mockReset().mockResolvedValue({});
  isEventOrganizerMock.mockReset().mockResolvedValue({ authorized: true, role: 'creator' });
}

// ─── Drizzle chain mock (repository tests) ─────────────────────────────────

export interface ChainCall {
  method: string;
  args: unknown[];
}

type Chain = Record<string, (...args: unknown[]) => Chain> & PromiseLike<unknown>;

/**
 * A fluent query-builder double: every method call is recorded and returns the
 * same chain; awaiting the chain resolves `result` (like drizzle's builders).
 */
function makeChain(result: unknown, calls: ChainCall[]): Chain {
  const proxy: Chain = new Proxy({} as Chain, {
    get(_target, property) {
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return proxy;
      };
    },
  });
  return proxy;
}

function createDbMock() {
  const results: unknown[] = [];
  const sqlResults: unknown[] = [];
  const calls: ChainCall[] = [];

  const start = (method: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return makeChain(results.shift(), calls);
    });

  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ method: 'sql', args: [strings.join('?').replaceAll(/\s+/g, ' ').trim(), ...values] });
    return Promise.resolve(sqlResults.shift());
  });

  return {
    db: { select: start('select'), insert: start('insert'), update: start('update') },
    sql,
    calls,
    /** Queue the result of the next `db.select/insert/update` chain. */
    queue: (result: unknown) => void results.push(result),
    /** Queue the rows of the next raw `sql` tagged-template call. */
    queueSql: (rows: unknown[]) => void sqlResults.push(rows),
    reset: () => {
      results.length = 0;
      sqlResults.length = 0;
      calls.length = 0;
      vi.clearAllMocks();
    },
    /** Recorded method names, in call order (e.g. `['select','from','where','limit']`). */
    methods: () => calls.map((c) => c.method),
    /** Arguments of the first recorded call to `method`. */
    argsOf: (method: string): unknown[] => calls.find((c) => c.method === method)?.args ?? [],
  };
}

export const dbMock = createDbMock();

/** `vi.mock('@/db')` replacement body: real schema tables, mocked `db` / `getClient`. */
export async function dbModuleMock(importOriginal: () => Promise<Record<string, unknown>>) {
  const actual = await importOriginal();
  return { ...actual, db: dbMock.db, getClient: () => dbMock.sql };
}

const dialect = new PgDialect();

/** Render a drizzle `where(...)` argument to `{ sql, params }` so tests can assert the predicate. */
export function renderSql(chunk: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(chunk as SQL);
}

/** `{ sql, params }` of the first `where` call recorded by `dbMock`. */
export function renderedWhere(): { sql: string; params: unknown[] } {
  return renderSql(dbMock.argsOf('where')[0]);
}

// ─── Row fixtures ──────────────────────────────────────────────────────────

export function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: EVENT_ID,
    did: 'did:imajin:event',
    creatorDid: CREATOR_DID,
    title: 'Test Event',
    startsAt: new Date('2026-12-01T20:00:00Z'),
    imageUrl: null,
    isVirtual: false,
    venue: null,
    status: 'published',
    accessMode: 'public',
    ...overrides,
  } as Event;
}

export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerDid: BUYER_DID,
    amountTotal: 55000,
    currency: 'CAD',
    paymentMethod: 'stripe',
    paymentId: 'pi_test',
    status: 'completed',
    buyerEmail: BUYER_EMAIL,
    ...overrides,
  } as Order;
}

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: TICKET_ID,
    eventId: EVENT_ID,
    ticketTypeId: TYPE_ID,
    orderId: ORDER_ID,
    ownerDid: BUYER_DID,
    status: 'valid',
    pricePaid: 27500,
    currency: 'CAD',
    paymentMethod: 'etransfer',
    registrationStatus: 'not_required',
    ...overrides,
  } as Ticket;
}

export function makeTicketType(overrides: Partial<TicketType> = {}): TicketType {
  return {
    id: TYPE_ID,
    eventId: EVENT_ID,
    name: 'General',
    price: 5000,
    currency: 'CAD',
    quantity: null,
    sold: 0,
    maxPerOrder: null,
    requiresRegistration: false,
    ...overrides,
  } as TicketType;
}
