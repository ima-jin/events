import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { makeEventRow, makeTierRow, jsonResponse } from './ui-support';
import { makeTicketTypeRow } from './events-support';

export const pageMocks = {
  requireAuth: vi.fn(),
  requireAdmin: vi.fn(),
  requireHardDID: vi.fn(),
  isEventOrganizer: vi.fn(),
  getEventWithTicketTypes: vi.fn(),
  listCreatorEvents: vi.fn(),
  listAdminEvents: vi.fn(),
  headers: vi.fn(),
  push: vi.fn(),
};

export const pageAuthModule = {
  requireAuth: pageMocks.requireAuth,
  requireAdmin: pageMocks.requireAdmin,
  requireHardDID: pageMocks.requireHardDID,
  resolveActingDid: (identity: { id: string; actingAs?: string }) => identity.actingAs || identity.id,
};

export function resetOrganizerPageMocks() {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  const actor = { identity: { id: 'did:imajin:creator', scopes: [], via: 'cookie' } };
  pageMocks.requireAuth.mockResolvedValue(actor);
  pageMocks.requireAdmin.mockResolvedValue(actor);
  pageMocks.requireHardDID.mockResolvedValue(actor);
  pageMocks.headers.mockResolvedValue(new Headers({ cookie: 'imajin_session=test' }));
  pageMocks.isEventOrganizer.mockResolvedValue({ authorized: true, role: 'creator' });
  pageMocks.getEventWithTicketTypes.mockResolvedValue({ event: makeEventRow(), ticketTypes: [makeTierRow()] });
  pageMocks.listCreatorEvents.mockResolvedValue([]);
  pageMocks.listAdminEvents.mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ guests: [], cohosts: [] }))));
}

export function creatorEvent() {
  return {
    ...makeEventRow(),
    startsAt: new Date('2099-12-01T18:00:00Z'),
    ticketTypes: [
      makeTicketTypeRow({ price: 1500, sold: 2 }),
      makeTicketTypeRow({ id: 'usd', price: 2000, sold: 1, currency: 'USD' }),
    ],
    ticketsSold: 3,
    revenue: 5000,
    statusBadge: 'live',
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
