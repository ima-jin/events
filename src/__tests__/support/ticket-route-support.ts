/**
 * Shared `vi.mock` boilerplate + fixtures for the ticket / refund / cohost
 * route suites (ticket refund, order refund, cancel, mark-refund-sent,
 * resend-email, registration-status, check-in, cohosts).
 *
 * These suites all exercise routes that sit on the same ported seams:
 *   - `@/lib/auth`            requireAuth / resolveActingDid
 *   - `@/lib/organizer`       isEventOrganizer
 *   - `@/lib/domain-events`   publish
 *   - `@/lib/kernel`          getContactEmail / evaluateEligibility (the rest
 *                             of the module — serviceUrl — stays real)
 *   - `@/lib/ticket-survey`   getSurveyResponseForTicket
 *   - `@/db`                  `db` (drizzle chains) and `getClient()` (raw sql)
 *
 * Importing this module BEFORE the route under test registers every mock
 * (vitest hoists `vi.mock`/`vi.hoisted`, and ES imports evaluate in order),
 * and sets the service-URL env the routes capture at module load.
 *
 * Every database / kernel result is queue-based (`nextSelect`, `nextSql`,
 * `nextReturning`) so tests read top-to-bottom in the order the route
 * performs its queries, and nothing leaks between tests (see
 * `resetTicketRouteMocks`).
 */
import { NextRequest } from 'next/server';
import { vi, it, expect } from 'vitest';

const hoisted = vi.hoisted(() => {
  const payServiceUrl = 'https://kernel.test/pay';
  const authServiceUrl = 'https://kernel.test/auth';
  const profileServiceUrl = 'https://kernel.test/profile';
  const connectionsServiceUrl = 'https://kernel.test/connections';
  const payApiKey = 'pay-api-key-fixture';

  // Routes capture these once, at import time.
  process.env.PAY_SERVICE_URL = payServiceUrl;
  process.env.AUTH_SERVICE_URL = authServiceUrl;
  process.env.PROFILE_SERVICE_URL = profileServiceUrl;
  process.env.CONNECTIONS_SERVICE_URL = connectionsServiceUrl;
  process.env.PAY_SERVICE_API_KEY = payApiKey;

  const selectQueue: unknown[][] = [];
  const sqlQueue: unknown[][] = [];
  const returningQueue: unknown[][] = [];
  const updateWhereOutcomes: { reject: boolean; error?: unknown }[] = [];

  const logMock = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  // db.select().from(x).where(y)[.limit(n)] — resolves the next queued rows.
  const selectMock = vi.fn(() => {
    const rows = selectQueue.shift() ?? [];
    return {
      from: () => ({
        where: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
      }),
    };
  });

  // db.update(x).set(y).where(z)[.returning()] — awaitable, `.catch`-able and
  // `.returning()`-able, like drizzle's query builder.
  const returningMock = vi.fn(() => Promise.resolve(returningQueue.shift() ?? []));
  const updateWhereMock = vi.fn(() => {
    const outcome = updateWhereOutcomes.shift();
    const result = outcome?.reject ? Promise.reject(outcome.error) : Promise.resolve(undefined);
    return Object.assign(result, { returning: returningMock });
  });
  const setMock = vi.fn<(values: Record<string, unknown>) => { where: typeof updateWhereMock }>(() => ({
    where: updateWhereMock,
  }));
  const updateMock = vi.fn<(table: unknown) => { set: typeof setMock }>(() => ({ set: setMock }));

  // Raw postgres.js client used as a tagged template: sql`SELECT ...`.
  const sqlMock = vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(() =>
    Promise.resolve(sqlQueue.shift() ?? [])
  );

  return {
    payServiceUrl,
    authServiceUrl,
    profileServiceUrl,
    connectionsServiceUrl,
    payApiKey,
    selectQueue,
    sqlQueue,
    returningQueue,
    updateWhereOutcomes,
    logMock,
    selectMock,
    returningMock,
    updateWhereMock,
    setMock,
    updateMock,
    sqlMock,
    requireAuthMock: vi.fn(),
    isEventOrganizerMock: vi.fn(),
    publishMock: vi.fn(),
    getContactEmailMock: vi.fn(),
    evaluateEligibilityMock: vi.fn(),
    getSurveyResponseForTicketMock: vi.fn(),
    generateQRCodeMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

export const {
  payServiceUrl,
  authServiceUrl,
  profileServiceUrl,
  connectionsServiceUrl,
  payApiKey,
  logMock,
  selectMock,
  updateWhereMock,
  setMock,
  updateMock,
  sqlMock,
  requireAuthMock,
  isEventOrganizerMock,
  publishMock,
  getContactEmailMock,
  evaluateEligibilityMock,
  getSurveyResponseForTicketMock,
  generateQRCodeMock,
  fetchMock,
} = hoisted;

vi.mock('@ima-jin/logger', () => ({
  createLogger: () => hoisted.logMock,
}));

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return {
    ...actual,
    db: { select: hoisted.selectMock, update: hoisted.updateMock },
    getClient: () => hoisted.sqlMock,
  };
});

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

vi.mock('@/lib/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kernel')>();
  return {
    ...actual,
    getContactEmail: hoisted.getContactEmailMock,
    evaluateEligibility: hoisted.evaluateEligibilityMock,
  };
});

vi.mock('@/lib/ticket-survey', () => ({
  getSurveyResponseForTicket: hoisted.getSurveyResponseForTicketMock,
}));

vi.mock('@/lib/email', () => ({
  generateQRCode: hoisted.generateQRCodeMock,
}));

vi.mock('@ima-jin/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ima-jin/config')>();
  return {
    ...actual,
    eventUrl: () => 'https://events.test/e/evt_1',
    eventRegisterUrl: () => 'https://events.test/e/evt_1/register',
    eventMyTicketsUrl: () => 'https://events.test/e/evt_1/my-tickets',
    buildPublicUrlAbsolute: () => 'https://events.test',
  };
});

vi.stubGlobal('fetch', fetchMock);

// ─── Queue helpers ─────────────────────────────────────────────────────────

/** Queue the rows for the next `db.select()...` chain. */
export function nextSelect(rows: unknown[]): void {
  hoisted.selectQueue.push(rows);
}

/** Queue the rows for the next raw `sql` tagged-template call. */
export function nextSql(rows: unknown[]): void {
  hoisted.sqlQueue.push(rows);
}

/** Queue the rows for the next `db.update()...returning()` call. */
export function nextReturning(rows: unknown[]): void {
  hoisted.returningQueue.push(rows);
}

/** Make a `db.update()...where()` reject with `error`, after `succeedFirst` update calls have succeeded. */
export function nextUpdateRejection(error: unknown, succeedFirst = 0): void {
  for (let i = 0; i < succeedFirst; i += 1) hoisted.updateWhereOutcomes.push({ reject: false });
  hoisted.updateWhereOutcomes.push({ reject: true, error });
}

/** Joined static text of the Nth raw `sql` call (to assert which statement ran). */
export function sqlStatement(callIndex: number): string {
  const strings = sqlMock.mock.calls[callIndex]?.[0] ?? [];
  return strings.join('?').replaceAll(/\s+/g, ' ').trim();
}

/** Tables passed to `db.update()`, in call order. */
export function updatedTables(): unknown[] {
  return updateMock.mock.calls.map(([table]) => table);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

export const EVENT_ID = 'evt_1';
export const TICKET_ID = 'tkt_1';
export const ORGANIZER_DID = 'did:imajin:organizer';
export const BUYER_DID = 'did:imajin:buyer';
export const ERR_UNAUTHORIZED = 'Unauthorized';
export const ERR_TICKET_NOT_FOUND = 'Ticket not found';
export const ERR_EVENT_NOT_FOUND = 'Event not found';
export const ERR_FORBIDDEN = 'Forbidden';

export const ROUTE_PARAMS = { params: Promise.resolve({ id: EVENT_ID, ticketId: TICKET_ID }) };

/** A NextRequest for an events-app URL (`path` starts with `/`), session cookie attached. */
export function makeRequest(path: string, method = 'POST', body?: Record<string, unknown>): NextRequest {
  return new NextRequest(`https://events.test${path}`, {
    method,
    headers: { cookie: 'session=abc', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** A NextRequest for `/api/events/evt_1/tickets/tkt_1/<action>`. */
export function makeTicketRequest(action: string, method = 'POST'): NextRequest {
  return makeRequest(`/api/events/${EVENT_ID}/tickets/${TICKET_ID}/${action}`, method);
}

/** Minimal fetch Response-like object. */
export function fakeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

/** Common `beforeEach` reset: empties every queue and restores the default mock behaviour. */
export function resetTicketRouteMocks(): void {
  vi.clearAllMocks();
  hoisted.selectQueue.length = 0;
  hoisted.sqlQueue.length = 0;
  hoisted.returningQueue.length = 0;
  hoisted.updateWhereOutcomes.length = 0;
  vi.unstubAllEnvs();

  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ identity: { id: ORGANIZER_DID, scopes: [], via: 'token' } });
  isEventOrganizerMock.mockReset();
  isEventOrganizerMock.mockResolvedValue({ authorized: true, role: 'creator' });
  publishMock.mockReset();
  publishMock.mockResolvedValue({});
  getContactEmailMock.mockReset();
  getContactEmailMock.mockResolvedValue(null);
  evaluateEligibilityMock.mockReset();
  evaluateEligibilityMock.mockResolvedValue(null);
  getSurveyResponseForTicketMock.mockReset();
  getSurveyResponseForTicketMock.mockResolvedValue(null);
  generateQRCodeMock.mockReset();
  generateQRCodeMock.mockResolvedValue('data:image/png;base64,stub');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(fakeResponse(200));
}

/** Assert the pay-service refund call (still `PAY_SERVICE_API_KEY` bearer auth — out of scope, imajin-ai#2739) and return its JSON body. */
export function expectPayRefundCall(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`${payServiceUrl}/api/refund`);
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ Authorization: `Bearer ${payApiKey}` });
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ─── Shared "it" blocks ────────────────────────────────────────────────────
// Identical auth / authorization checks across the whole family, extracted
// (rather than copy-pasted per suite) to keep new-code duplication down.

type RouteCall = () => Promise<Response>;

export function itReturns401WhenAuthFails(call: RouteCall): void {
  it('returns 401 when auth fails', async () => {
    requireAuthMock.mockResolvedValue({ error: ERR_UNAUTHORIZED, status: 401 });

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: ERR_UNAUTHORIZED });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });
}

/** `queueRows` runs first so routes that look the event up before the organizer check can be covered too. */
export function itReturns403WhenNotOrganizer(call: RouteCall, queueRows?: () => void): void {
  it('returns 403 when caller is not an organizer', async () => {
    queueRows?.();
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await call();

    expect(res.status).toBe(403);
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, expect.any(Request));
    expect(sqlMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
}
