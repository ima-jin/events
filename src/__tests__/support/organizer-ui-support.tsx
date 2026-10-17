import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { EventForm, FairAttribution, type EventFormEvent, type EventFormProps, type EventFormTier, type FairAttributionManifest, type FairAttributionProps } from '@/components/organizer-form';
import type { OrganizerGuest } from '@/components/organizer/guest-list';
import type { OrganizerSale } from '@/components/organizer/sales-tab';
import type { OrganizerCohost } from '@/components/organizer/cohost-manager';
import { makeEventRow, makeTierRow, jsonResponse, mockFetch as baseMockFetch } from './ui-support';
import { makeTicketTypeRow } from './events-support';
export { jsonResponse } from './ui-support';

export function mockFetch(routes: Parameters<typeof baseMockFetch>[0]) {
  return baseMockFetch({ '/api/proxy/connections': jsonResponse({ connections: [] }), ...routes });
}

export const EVENT_ID = 'evt_1';
export const CREATOR_DID = 'did:imajin:creator';
export const push = vi.fn();
export const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  notFound: () => { throw new Error('NEXT_HTTP_ERROR_FALLBACK;404'); },
}));
beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

export function eventFixture(overrides: Partial<EventFormEvent> = {}): EventFormEvent {
  return {
    id: 'evt_edit', title: 'Meetup', startsAt: '2099-12-01T18:00:00.000Z', timezone: 'UTC',
    description: 'Original description', status: 'draft', accessMode: 'public',
    metadata: { linkedSurveys: [{ id: 'survey_old' }], campaign: { untouched: true } }, ...overrides,
  };
}

export function tierFixture(overrides: Partial<EventFormTier> = {}): EventFormTier {
  return {
    id: 'tier_existing', name: 'General', price: 2000, currency: 'CAD', quantity: 10, sold: 2,
    perks: ['Recording'], ...overrides,
  };
}

export function renderForm(props: EventFormProps = { mode: 'create' }) {
  return { user: userEvent.setup(), ...render(<EventForm {...props} />) };
}

export function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

export function fillCreate() {
  change('Event title', 'A new meetup');
  change('Start date and time', '2099-12-01T18:00');
}

export function body(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body || '{}'));
}

export function manifestFixture(): FairAttributionManifest {
  return {
    fair: '1.0', id: 'fair_event', type: 'ticket', owner: CREATOR_DID,
    created: '2026-10-14T15:00:00Z', access: 'public',
    attribution: [{ did: CREATOR_DID, role: 'creator', share: 1 }],
    transfer: { allowed: true, refundable: false, faceValueCap: true },
  };
}

export function renderAttribution(props: Partial<FairAttributionProps> = {}) {
  return { user: userEvent.setup(), ...render(<FairAttribution eventId="evt_edit" manifest={manifestFixture()} {...props} />) };
}

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

export const pageMocks = {
  requireAuth: vi.fn(),
  requireAdmin: vi.fn(),
  requireHardDID: vi.fn(),
  isEventOrganizer: vi.fn(),
  getEventWithTicketTypes: vi.fn(),
  listCreatorEvents: vi.fn(),
  listAdminEvents: vi.fn(),
  headers: vi.fn(),
  push,
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
  const actor = { identity: { id: CREATOR_DID, scopes: [], via: 'cookie' } };
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
