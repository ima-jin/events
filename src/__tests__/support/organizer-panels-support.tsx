import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { OrganizerGuest } from '@/components/organizer/guest-list';
import type { OrganizerSale } from '@/components/organizer/sales-tab';
import type { OrganizerCohost } from '@/components/organizer/cohost-manager';
import { jsonResponse, mockFetch as mockUiFetch } from './ui-support';
export { jsonResponse } from './ui-support';
export function mockFetch(routes: Parameters<typeof mockUiFetch>[0]) {
  return mockUiFetch({ '/api/proxy/connections': jsonResponse({ connections: [] }), ...routes });
}
afterEach(() => vi.unstubAllEnvs());

export const EVENT_ID = 'evt_1';
export const CREATOR_DID = 'did:imajin:creator';

export function makeGuest(overrides: Partial<OrganizerGuest> = {}): OrganizerGuest {
  return {
    id: 'ticket_1', status: 'valid', ownerDid: 'did:imajin:guest', pricePaid: 2500, currency: 'CAD',
    ticketType: 'General', paymentMethod: 'stripe', paymentId: 'pi_1', registrationStatus: 'complete',
    attendeeName: null, resolvedName: 'Ada', resolvedEmail: 'ada@example.test', guestOf: null,
    usedAt: null, lastEmailSentAt: null, profile: null, ...overrides,
  };
}

export function makeSale(overrides: Partial<OrganizerSale> = {}): OrganizerSale {
  return {
    orderId: 'order_1', buyerDid: 'did:imajin:guest', buyerName: 'Ada', buyerHandle: null,
    buyerEmail: 'ada@example.test', ticketType: 'General', quantity: 1, amountTotal: 2500,
    currency: 'CAD', paymentMethod: 'stripe', purchasedAt: '2026-10-14T10:00:00Z', status: 'completed',
    ...overrides,
  };
}

export function makeCohost(overrides: Partial<OrganizerCohost> = {}): OrganizerCohost {
  return { did: 'did:imajin:cohost', name: 'Lin', handle: 'lin', role: 'cohost', addedAt: '2026-10-14', ...overrides };
}

export function renderPanel(component: ReactElement) {
  return { user: userEvent.setup(), ...render(component) };
}

export function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  vi.stubGlobal('fetch', vi.fn(() => promise));
  return resolve;
}
