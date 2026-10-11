/**
 * Shared test support for the events domain (service + repository suites).
 *
 *   - fixtures: `makeEventRow`, `makeTicketTypeRow`
 *   - `createDrizzleChain`: an awaitable drizzle query-builder double
 *   - `dbMock`: stand-in for `db` in `@/db` (repository suites)
 *   - module doubles for the service suite's seams (`repoMocks`, `kernelModule`,
 *     `domainEventsModule`, `loggerModule`, `configModule`, `authorizationModule`),
 *     each wired into a suite with
 *     `vi.mock('<module>', async () => (await import('../support/events-support')).<double>)`
 *     and reset with `resetServiceMocks()`.
 */
import { vi } from 'vitest';
import type { EventRow, TicketTypeRow } from '@/repositories/events-repository';

export const CREATOR_DID = 'did:imajin:creator';
export const EVENT_DID = 'did:imajin:event123';
export const CHAT_URL = 'https://chat.events.test';
export const AUTH_URL = 'https://auth.events.test';

// ─── Fixtures ───────────────────────────────────────────────────────────────

export function makeEventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'evt_1',
    did: EVENT_DID,
    creatorDid: CREATOR_DID,
    title: 'Test Meetup',
    status: 'draft',
    startsAt: new Date('2026-12-01T18:00:00.000Z'),
    privateKey: 'secret-key',
    ...overrides,
  } as EventRow;
}

export function makeTicketTypeRow(overrides: Partial<TicketTypeRow> = {}): TicketTypeRow {
  return {
    id: 'tkt_type_1',
    eventId: 'evt_1',
    name: 'General',
    price: 2000,
    currency: 'CAD',
    quantity: 10,
    sold: 4,
    ...overrides,
  } as TicketTypeRow;
}

// ─── Drizzle doubles (repository suites) ────────────────────────────────────

const CHAIN_METHODS = ['from', 'where', 'orderBy', 'limit', 'values', 'set', 'returning'] as const;

export type DrizzleChain = Record<(typeof CHAIN_METHODS)[number], ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

/** A chainable query builder that resolves to `result` when awaited at any point of the chain. */
export function createDrizzleChain(result: unknown): DrizzleChain {
  const chain = {
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as DrizzleChain;
  for (const method of CHAIN_METHODS) {
    chain[method] = vi.fn(() => chain);
  }
  return chain;
}

export const dbMock = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };

// ─── Module doubles (service suite) ─────────────────────────────────────────

export const repoMocks = {
  getEventOwnership: vi.fn(),
  getEventById: vi.fn(),
  getEventSummaryByDid: vi.fn(),
  listEvents: vi.fn(),
  listEventsByCreator: vi.fn(),
  insertEvent: vi.fn(),
  updateEventById: vi.fn(),
  listTicketTypesForEvent: vi.fn(),
  insertTicketTypes: vi.fn(),
};

const publishMock = vi.fn();
const serviceUrlMock = vi.fn();
const getNodeSelfMock = vi.fn();
const getForestScopeConfigMock = vi.fn();
const isEventOrganizerMock = vi.fn();
const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

export const kernelModule = {
  serviceUrl: serviceUrlMock,
  appAuthHeaders: () => ({ 'X-App-DID': 'did:imajin:events-app' }),
};
export const domainEventsModule = { publish: publishMock };
export const loggerModule = { createLogger: () => log };
export const configModule = { getNodeSelf: getNodeSelfMock, getForestScopeConfig: getForestScopeConfigMock };
export const authorizationModule = { isEventOrganizer: isEventOrganizerMock };

export const serviceMocks = {
  publish: publishMock,
  serviceUrl: serviceUrlMock,
  getNodeSelf: getNodeSelfMock,
  getForestScopeConfig: getForestScopeConfigMock,
  isEventOrganizer: isEventOrganizerMock,
  log,
};

const SERVICE_URLS: Record<string, string> = { auth: AUTH_URL, chat: CHAT_URL };

/**
 * Reset every double to its happy-path default: auth and chat configured, no node config,
 * publishing succeeds, the actor is an organizer, and inserts echo what they were given.
 */
export function resetServiceMocks(): void {
  vi.clearAllMocks();
  for (const mock of Object.values(repoMocks)) mock.mockReset();
  repoMocks.insertEvent.mockImplementation(async (values: EventRow) => values);
  repoMocks.insertTicketTypes.mockImplementation(async (values: TicketTypeRow[]) => values);
  publishMock.mockReset().mockResolvedValue({});
  serviceUrlMock.mockReset().mockImplementation((service: string) => SERVICE_URLS[service] ?? null);
  getNodeSelfMock.mockReset().mockResolvedValue(null);
  getForestScopeConfigMock.mockReset().mockResolvedValue(null);
  isEventOrganizerMock.mockReset().mockResolvedValue({ authorized: true, role: 'creator' });
}
