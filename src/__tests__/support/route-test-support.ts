/**
 * Shared `vi.mock` boilerplate + helpers for the ticket / order route suites
 * (check-in, cancel, refund, mark-refund-sent, registration-status, resend-email,
 * order refund). They all exercise handlers behind `requireAuth` +
 * `isEventOrganizer`, backed by a Drizzle `db.select()/update()` chain and/or the
 * raw `getClient()` SQL client — so the doubles live here once.
 *
 * Vitest hoists `vi.mock`/`vi.hoisted` in whichever module they are written in,
 * and imports run in order, so importing this module before the route under test
 * registers every mock exactly as if it were declared inline in the test file.
 */
import { vi, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => {
  // Raw postgres client (getClient)
  const sqlMock = vi.fn().mockResolvedValue([]);

  // Drizzle select chain: db.select().from(x).where(y).limit(n)
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  // Drizzle update chain: db.update(x).set(y).where(z)[.returning()|.catch(fn)]
  const returningMock = vi.fn().mockResolvedValue([]);
  const updateResult = () => Object.assign(Promise.resolve(undefined), { returning: returningMock });
  const updateWhereMock = vi.fn(updateResult);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  // Drizzle insert chain: db.insert(x).values(y)
  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  return {
    sqlMock,
    whereMock,
    fromMock,
    selectMock,
    returningMock,
    updateResult,
    updateWhereMock,
    setMock,
    updateMock,
    insertValuesMock,
    insertMock,
    requireAuthMock: vi.fn(),
    isEventOrganizerMock: vi.fn(),
    publishMock: vi.fn().mockResolvedValue(undefined),
  };
});

export const mocks = hoisted;

vi.mock('@ima-jin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@/db', () => ({
  getClient: () => hoisted.sqlMock,
  db: { select: hoisted.selectMock, update: hoisted.updateMock, insert: hoisted.insertMock },
  events: { id: 'col_id', title: 'col_title' },
  orders: { id: 'col_id', status: 'col_status', eventId: 'col_eventId', buyerDid: 'col_buyerDid' },
  tickets: {
    id: 'col_id',
    eventId: 'col_eventId',
    status: 'col_status',
    ownerDid: 'col_ownerDid',
    orderId: 'col_orderId',
    ticketTypeId: 'col_ttId',
  },
  ticketTypes: { id: 'col_ttId', sold: 'col_sold', registrationFormId: 'col_formId' },
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: hoisted.requireAuthMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/lib/organizer', () => ({
  isEventOrganizer: hoisted.isEventOrganizerMock,
}));

vi.mock('@/lib/domain-events', () => ({
  publish: hoisted.publishMock,
}));

/** Route context for `/api/events/evt_1/tickets/tkt_1/...` handlers. */
export const TICKET_ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1', ticketId: 'tkt_1' }) };

/** A request to `/api/events/evt_1/tickets/tkt_1/<action>` carrying a session cookie. */
export function ticketRequest(action: string, method = 'POST'): NextRequest {
  return new NextRequest(`https://events.test/api/events/evt_1/tickets/tkt_1/${action}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: 'session=abc' },
  });
}

/** Queue a Drizzle `select().from().where()[.limit()]` result for the next `where` call. */
export function nextDrizzleSelect(rows: unknown[]): void {
  const p = Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
  hoisted.whereMock.mockImplementationOnce(() => p);
}

/** Queue a raw SQL result for the next `getClient()` call. */
export function nextSql(rows: unknown[]): void {
  hoisted.sqlMock.mockResolvedValueOnce(rows);
}

/** Common `beforeEach` reset: organizer caller, authorized, default empty results. */
export function resetRouteMocks(): void {
  vi.clearAllMocks();
  hoisted.whereMock.mockReset();
  hoisted.sqlMock.mockReset();
  hoisted.sqlMock.mockResolvedValue([]);
  hoisted.returningMock.mockResolvedValue([]);
  hoisted.updateWhereMock.mockImplementation(hoisted.updateResult);
  hoisted.publishMock.mockResolvedValue(undefined);
  hoisted.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:organizer' } });
  hoisted.isEventOrganizerMock.mockResolvedValue({ authorized: true });
}

type Handler = (request: NextRequest, context: typeof TICKET_ROUTE_PARAMS) => Promise<Response>;

/** Declares the shared "401 when auth fails" case. */
export function testReturns401WhenAuthFails(handler: Handler, makeRequest: () => NextRequest): void {
  it('returns 401 when auth fails', async () => {
    hoisted.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    const res = await handler(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });
}

/** Declares the shared "403 for a non-organizer" case; `assertNoWork` checks nothing was queried. */
export function testReturns403ForNonOrganizer(
  handler: Handler,
  makeRequest: () => NextRequest,
  assertNoWork?: () => void
): void {
  it('returns 403 when caller is not an organizer', async () => {
    hoisted.isEventOrganizerMock.mockResolvedValue({ authorized: false });
    const res = await handler(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(403);
    assertNoWork?.();
  });
}
