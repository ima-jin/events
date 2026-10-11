/**
 * Shared doubles + fixtures for the ticket-types (tiers) suites:
 *   - service tests mock the repository and the authorization service
 *     (`repositoryMock`, `authorizationMock`);
 *   - repository tests swap `db` for a drizzle-style chain (`dbChain`).
 *
 * Test files register them with
 *   vi.mock('<module>', async () => (await import('./support/ticket-types-support')).<double>)
 * so nothing is hoisted twice and no boilerplate is copied between files.
 */
import { vi } from 'vitest';
import type { TicketTypeRow } from '@/repositories/ticket-types-repository';

export const EVENT_ID = 'evt_1';
export const ORGANIZER_DID = 'did:imajin:organizer';
export const COOKIE = 'session=abc';

/** A complete ticket_types row; override what a test cares about. */
export function makeTier(overrides: Partial<TicketTypeRow> = {}): TicketTypeRow {
  return {
    id: 'tkt_type_1',
    eventId: EVENT_ID,
    name: 'General',
    description: null,
    price: 5000,
    currency: 'CAD',
    quantity: 100,
    sold: 10,
    perks: [],
    metadata: {},
    sortOrder: 0,
    requiresRegistration: false,
    registrationFormId: null,
    maxPerOrder: null,
    accessCode: null,
    createdAt: null,
    ...overrides,
  };
}

/** `@/repositories/ticket-types-repository` with every function a mock. */
export const repositoryMock = {
  listPublicTicketTypes: vi.fn(),
  listTicketTypesByAccessCode: vi.fn(),
  listTicketTypeCurrencies: vi.fn(),
  getTicketTypeForEvent: vi.fn(),
  insertTicketType: vi.fn(),
  updateTicketType: vi.fn(),
};

/** `@/services/authorization` with a mockable organizer check. */
export const authorizationMock = { isEventOrganizer: vi.fn() };

export function resetServiceMocks(): void {
  for (const fn of Object.values(repositoryMock)) fn.mockReset();
  authorizationMock.isEventOrganizer.mockReset().mockResolvedValue({ authorized: true, role: 'creator' });
}

const CHAIN_METHODS = ['select', 'from', 'where', 'orderBy', 'limit', 'insert', 'values', 'update', 'set', 'returning'] as const;

/**
 * A drizzle query-builder double: every builder method returns the chain, and
 * awaiting the chain (at any point) yields the rows set with `resolveWith`.
 */
function createDbChain() {
  let outcome: Promise<unknown[]> = Promise.resolve([]);
  const chain: Record<string, unknown> = {
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (error: unknown) => unknown) =>
      outcome.then(onFulfilled, onRejected),
  };
  const methods = {} as Record<(typeof CHAIN_METHODS)[number], ReturnType<typeof vi.fn>>;
  for (const name of CHAIN_METHODS) {
    methods[name] = vi.fn(() => chain);
    chain[name] = methods[name];
  }
  return {
    db: chain,
    methods,
    resolveWith(rows: unknown[]): void {
      outcome = Promise.resolve(rows);
    },
    rejectWith(error: Error): void {
      outcome = Promise.reject(error);
    },
  };
}

export const dbChain = createDbChain();

/** `@/db` with the real schema tables and the chain double as `db`. */
export async function mockDbModule(importOriginal: () => Promise<Record<string, unknown>>) {
  return { ...(await importOriginal()), db: dbChain.db };
}
