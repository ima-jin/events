/**
 * Shared test support for the public-display UI suites (jsdom).
 *
 *   - fixtures: `makeTier`, `makeEventView`, `makeEventRow`, `makeTierRow`
 *   - `mockFetch`: route-table `fetch` stub (+ `jsonResponse`) for the checkout / unlock / balance calls
 *   - `renderPurchase`: renders `<TicketPurchase>` with sensible props and a ready `userEvent`
 *   - module doubles for the page suites' seams (`eventsServiceDouble`, `authClientDouble`),
 *     wired with `vi.mock('<module>', async () => (await import('../support/ui-support')).<double>)`
 *
 * Importing this module also registers RTL's DOM cleanup after every test.
 */
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { TicketPurchase, type TicketPurchaseProps } from '@/components/tickets/ticket-purchase';
import type { PublicEventView, PublicTier } from '@/lib/public-event';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

export const EVENT_ID = 'evt_1';

export function makeTier(overrides: Partial<PublicTier> = {}): PublicTier {
  return {
    id: 'tier_general',
    name: 'General',
    description: null,
    price: 2000,
    currency: 'CAD',
    quantity: null,
    available: null,
    perks: [],
    maxPerOrder: null,
    ...overrides,
  };
}

export const FREE_TIER = makeTier({ id: 'tier_free', name: 'Community', price: 0 });

export function makeEventView(overrides: Partial<PublicEventView> = {}): PublicEventView {
  return {
    id: EVENT_ID,
    title: 'Test Meetup',
    description: null,
    startsAt: '2099-12-01T18:00:00.000Z',
    endsAt: null,
    timezone: 'UTC',
    status: 'published',
    accessMode: 'public',
    eventType: 'event',
    locationType: 'physical',
    venue: 'The Hall',
    address: '1 Main St',
    city: 'Toronto',
    imageUrl: null,
    featured: false,
    theme: { emoji: '🎉', gradient: ['from-orange-500', 'to-amber-600'] },
    maxTicketsPerOrder: null,
    etransferEnabled: false,
    ...overrides,
  };
}

/** An events-service event row (what `getEventWithTicketTypes` returns), including fields that must never leak. */
export function makeEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    did: 'did:imajin:event123',
    creatorDid: 'did:imajin:creator',
    title: 'Test Meetup',
    description: 'A friendly meetup',
    startsAt: new Date('2099-12-01T18:00:00.000Z'),
    endsAt: null,
    timezone: 'UTC',
    status: 'published',
    accessMode: 'public',
    eventType: 'event',
    locationType: 'physical',
    venue: 'The Hall',
    address: '1 Main St',
    city: 'Toronto',
    imageUrl: null,
    metadata: { fair: { secret: 'manifest' } },
    emtEmail: null,
    privateKey: 'super-secret-key',
    ...overrides,
  };
}

export function makeTierRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tier_general',
    eventId: EVENT_ID,
    name: 'General',
    price: 2000,
    currency: 'CAD',
    quantity: null,
    sold: 0,
    available: null,
    perks: [],
    accessCode: null,
    ...overrides,
  };
}

// ─── fetch stub ─────────────────────────────────────────────────────────────

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Route = Response | ((init: RequestInit | undefined) => Response | Promise<Response>);

/**
 * Stub `fetch` with a route table keyed by a path fragment (first match wins,
 * unmatched calls answer 404). Returns the spy so tests can assert on calls.
 */
export function mockFetch(routes: Record<string, Route>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((fragment) => url.includes(fragment));
    if (!key) return jsonResponse({ error: 'not found' }, 404);
    const route = routes[key];
    return typeof route === 'function' ? route(init) : route.clone();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Parsed JSON body of the n-th call to a `mockFetch` spy whose URL contains `fragment`. */
export function requestBody(spy: ReturnType<typeof mockFetch>, fragment: string): Record<string, unknown> {
  const call = spy.mock.calls.find(([url]) => String(url).includes(fragment));
  return JSON.parse(String(call?.[1]?.body ?? '{}'));
}

// ─── Component helpers ──────────────────────────────────────────────────────

export const PURCHASE_DEFAULTS: TicketPurchaseProps = {
  eventId: EVENT_ID,
  tiers: [makeTier()],
  hasHiddenTiers: false,
  etransferEnabled: false,
  isAuthenticated: false,
  maxTicketsPerOrder: null,
};

export function renderPurchase(overrides: Partial<TicketPurchaseProps> = {}) {
  const user = userEvent.setup();
  const view = render(<TicketPurchase {...PURCHASE_DEFAULTS} {...overrides} />);
  return { user, ...view };
}

// ─── Module doubles (page suites) ───────────────────────────────────────────

export const eventsServiceDouble = {
  getEventWithTicketTypes: vi.fn(),
  listEvents: vi.fn(),
};

export const authClientDouble = {
  getSession: vi.fn(),
};

export function resetPageMocks() {
  eventsServiceDouble.getEventWithTicketTypes.mockReset();
  eventsServiceDouble.listEvents.mockReset();
  authClientDouble.getSession.mockReset();
  authClientDouble.getSession.mockResolvedValue(null);
}

/** Make `getEventWithTicketTypes` answer with this event + tier rows. */
export function givenEvent(event: Record<string, unknown> = makeEventRow(), ticketTypes: Record<string, unknown>[] = [makeTierRow()]) {
  eventsServiceDouble.getEventWithTicketTypes.mockResolvedValue({ event, ticketTypes });
}
