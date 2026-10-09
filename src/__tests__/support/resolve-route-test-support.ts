/**
 * Shared `vi.mock` boilerplate + fixtures for the event reporting route
 * suites (sales, sales/export, guests, guests/export.csv).
 *
 * These routes all exercise the same seams of the ported app:
 *   - `@/db` `getClient()`          → raw-SQL tagged template (queued results)
 *   - `@/lib/organizer`             → `isEventOrganizer`
 *   - `@/lib/kernel`                → `resolveProfiles` (batched DID → profile)
 *   - `@/lib/surveys`               → dykil survey reads (never its tables)
 *   - `@/lib/auth` (via ./route-test-support) → `requireAuth`
 *
 * Importing this module (before the route under test) registers every mock.
 */
import { vi, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import {
  authFailure,
  authSuccess,
  requireAuthMock,
  resetRouteTestMocks,
} from './route-test-support';

export { requireAuthMock, requireAppAuthMock, mockLog } from './route-test-support';

export type EventRouteContext = { params: Promise<{ id: string }> };
export type EventRouteHandler = (request: NextRequest, context: EventRouteContext) => Promise<Response>;

export const EVENT_ID = 'evt_1';
export const ROUTE_PARAMS: EventRouteContext = { params: Promise.resolve({ id: EVENT_ID }) };
export const BUYER_DID = 'did:imajin:buyer';
export const OWNER_DID = 'did:imajin:owner';

const hoisted = vi.hoisted(() => {
  const queue: unknown[][] = [];
  // Bare/fragment templates with zero interpolated values (e.g. a
  // conditional `sql`` filter fragment embedded in another query) are only
  // ever composed into another `sql`...${fragment}...`` call in real
  // postgres.js usage — never awaited standalone — so they must not
  // consume from the queue.
  const sqlMock = (_strings: TemplateStringsArray, ...values: unknown[]) =>
    values.length === 0 ? ({ __fragment: true } as unknown) : Promise.resolve(queue.shift() ?? []);
  return {
    queue,
    sqlMock,
    isEventOrganizerMock: vi.fn(),
    resolveProfilesMock: vi.fn(),
    getSurveyResponsesForTicketsMock: vi.fn(),
    getSurveyFormsMock: vi.fn(),
  };
});

export const {
  isEventOrganizerMock,
  resolveProfilesMock,
  getSurveyResponsesForTicketsMock,
  getSurveyFormsMock,
} = hoisted;

vi.mock('@/db', () => ({
  getClient: () => hoisted.sqlMock,
}));

vi.mock('@/lib/organizer', () => ({
  isEventOrganizer: hoisted.isEventOrganizerMock,
}));

// Only `resolveProfiles` is replaced; the rest of `@/lib/kernel` is real.
vi.mock('@/lib/kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kernel')>()),
  resolveProfiles: hoisted.resolveProfilesMock,
}));

vi.mock('@/lib/surveys', () => ({
  getSurveyResponsesForTickets: hoisted.getSurveyResponsesForTicketsMock,
  getSurveyForms: hoisted.getSurveyFormsMock,
}));

/** Queue a raw-SQL result for the next real (non-fragment) `sql` tagged-template call. */
export function nextSql(rows: unknown[]): void {
  hoisted.queue.push(rows);
}

/** Build a signed-in request to `/api/events/evt_1/<suffix>`. */
export function makeEventRequest(suffix: string, query = ''): NextRequest {
  return new NextRequest(`https://events.test/api/events/${EVENT_ID}/${suffix}${query}`, {
    headers: { cookie: 'session=abc' },
  });
}

/** Common `beforeEach` reset every suite in this family shares. */
export function resetResolveRouteMocks(): void {
  resetRouteTestMocks();
  hoisted.queue.length = 0;
  isEventOrganizerMock.mockReset().mockResolvedValue({ authorized: true, role: 'creator' });
  resolveProfilesMock.mockReset().mockResolvedValue(new Map());
  getSurveyResponsesForTicketsMock.mockReset().mockResolvedValue(new Map());
  getSurveyFormsMock.mockReset().mockResolvedValue(new Map());
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

/**
 * Shared "it" blocks for the auth/authorization/not-found/error checks that
 * are identical across every route in this family — extracted (rather than
 * copy-pasted per suite) to avoid new-code duplication. Each one declares a
 * single `it(...)`; call from inside a suite's own `describe` block.
 */
export function testReturns401WhenAuthFails(GET: EventRouteHandler, makeRequest: () => NextRequest): void {
  it('returns 401 when auth fails', async () => {
    requireAuthMock.mockResolvedValue(authFailure());

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });
}

export function testReturns403ForNonOrganizer(GET: EventRouteHandler, makeRequest: () => NextRequest): void {
  it('returns 403 for a non-organizer without resolving identities', async () => {
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(resolveProfilesMock).not.toHaveBeenCalled();
  });
}

export function testReturns404WhenEventNotFound(GET: EventRouteHandler, makeRequest: () => NextRequest): void {
  it('returns 404 when the event is not found', async () => {
    nextSql([]); // event lookup misses

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });
}

export function testReturns500OnUnexpectedError(GET: EventRouteHandler, makeRequest: () => NextRequest): void {
  it('returns 500 when an unexpected error is thrown', async () => {
    isEventOrganizerMock.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(500);
  });
}

/** The acting DID the organizer check must be asked about (the authenticated caller). */
export function expectOrganizerCheckedFor(did: string = authSuccess().identity.id): void {
  expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, did, expect.anything());
}
