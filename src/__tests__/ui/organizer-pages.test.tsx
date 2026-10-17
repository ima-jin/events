// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { creatorEvent, pageMocks, resetOrganizerPageMocks } from '../support/organizer-ui-support';
import { makeEventRow, makeTierRow } from '../support/ui-support';
import { ServiceError } from '@/services/errors';

vi.mock('@/lib/auth', async () => (await import('../support/organizer-ui-support')).pageAuthModule);
const cardRail = vi.hoisted(() => ({ getCardRailReadiness: vi.fn() }));
vi.mock('@/lib/card-rail', () => cardRail);
vi.mock('next/headers', async () => ({ headers: (await import('../support/organizer-ui-support')).pageMocks.headers }));
vi.mock('@/services/authorization', async () => ({
  isEventOrganizer: (await import('../support/organizer-ui-support')).pageMocks.isEventOrganizer,
}));
vi.mock('@/services/events-service', async () => {
  const { pageMocks: mocks } = await import('../support/organizer-ui-support');
  return { getEventWithTicketTypes: mocks.getEventWithTicketTypes, listCreatorEvents: mocks.listCreatorEvents };
});
vi.mock('@/services/admin-export-service', async () => ({
  listAdminEvents: (await import('../support/organizer-ui-support')).pageMocks.listAdminEvents,
}));

import DashboardPage from '../../../app/dashboard/page';
import AdminPage from '../../../app/admin/page';
import EventAdminPage from '../../../app/admin/[eventId]/page';
import CreatePage from '../../../app/create/page';
import EditPage from '../../../app/e/[eventId]/edit/page';
import LegacyEditPage from '../../../app/[eventId]/edit/page';
import { eventFormView, tierFormView } from '@/lib/organizer-form-view';
import { loadOrganizerPage, requirePageActor } from '@/lib/organizer-page';
import type { TicketTypeWithAvailability } from '@/services/events-service';
import { OrganizerPageError, OrganizerPageLoading } from '@/components/organizer-page-state';
import userEvent from '@testing-library/user-event';
import { feeManifestFixture } from '../support/editable-fair-fixtures';

const route = { params: Promise.resolve({ eventId: 'evt_1' }) };
beforeEach(() => {
  resetOrganizerPageMocks();
  cardRail.getCardRailReadiness.mockResolvedValue({ cardEnabled: false, setupUrl: 'https://kernel.example/auth/connectors/stripe' });
});

describe('server organizer authorization', () => {
  it('passes the caller cookie to the organizer service before loading data', async () => {
    await loadOrganizerPage('evt_1');
    expect(pageMocks.isEventOrganizer).toHaveBeenCalledWith('evt_1', 'did:imajin:creator', 'imajin_session=test');
    expect(pageMocks.getEventWithTicketTypes).toHaveBeenCalledWith('evt_1', 'public');
  });

  it.each([EditPage, EventAdminPage])('checks readiness for stored creator rather than a co-host actor', async (page) => {
    pageMocks.isEventOrganizer.mockResolvedValue({ authorized: true, role: 'cohost' });
    pageMocks.getEventWithTicketTypes.mockResolvedValue({ event: makeEventRow({ creatorDid: 'did:imajin:stored-host' }), ticketTypes: [] });
    render(await page(route));
    expect(cardRail.getCardRailReadiness).toHaveBeenCalledWith('did:imajin:stored-host');
  });

  it.each([EventAdminPage, EditPage, LegacyEditPage])('404s for non-organizers before reading event fields', async (page) => {
    pageMocks.isEventOrganizer.mockResolvedValue({ authorized: false });
    await expect(page(route)).rejects.toThrow('404');
    expect(pageMocks.getEventWithTicketTypes).not.toHaveBeenCalled();
  });

  it.each([DashboardPage, CreatePage, AdminPage])('fails closed when authentication or special access is denied', async (page) => {
    pageMocks.requireAuth.mockResolvedValue({ error: 'Unauthenticated', status: 401 });
    pageMocks.requireHardDID.mockResolvedValue({ error: 'Hard DID required', status: 403 });
    pageMocks.requireAdmin.mockResolvedValue({ error: 'Forbidden', status: 403 });
    await expect(page()).rejects.toThrow('404');
  });

  it('maps a missing event to 404 but propagates service outages', async () => {
    pageMocks.getEventWithTicketTypes.mockRejectedValueOnce(new ServiceError('not_found', 'Missing'));
    await expect(loadOrganizerPage('missing')).rejects.toThrow('404');
    pageMocks.getEventWithTicketTypes.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(loadOrganizerPage('evt_1')).rejects.toThrow('Database unavailable');
  });

  it('keeps verified act-as identity and uses write scopes for creation', async () => {
    pageMocks.requireHardDID.mockResolvedValue({ identity: { id: 'did:me', actingAs: 'did:group' } });
    expect(await requirePageActor('create')).toMatchObject({ did: 'did:group' });
    expect(pageMocks.requireHardDID.mock.calls[0][0].method).toBe('POST');
  });
});

describe('organizer pages', () => {
  it('announces server-page loading and offers retry without leaking error details', async () => {
    const reset = vi.fn();
    render(<><OrganizerPageLoading /><OrganizerPageError reset={reset} /></>);
    expect(screen.getByRole('status').textContent).toContain('Loading organizer tools');
    expect(screen.getByRole('alert').textContent).toContain('Please try again');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });
  it('renders an empty creator dashboard', async () => {
    render(await DashboardPage());
    expect(screen.getByRole('heading', { name: 'My Events' })).toBeTruthy();
    expect(screen.getByText('No events yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create Event' }).getAttribute('href')).toBe('/create');
  });

  it('renders creator events with currency-separated revenue and local action links', async () => {
    pageMocks.listCreatorEvents.mockResolvedValue([creatorEvent()]);
    render(await DashboardPage());
    expect(screen.getByText('3 tickets sold')).toBeTruthy();
    expect(screen.getByText(/\$30.00 CAD revenue/)).toBeTruthy();
    expect(screen.getByText(/20.00 USD revenue/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage event' }).getAttribute('href')).toBe('/admin/evt_1');
    expect(globalThis.document.body.innerHTML).not.toContain('super-secret-key');
  });

  it('renders the allowlisted admin overview and base-path-aware CSV link', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    pageMocks.listAdminEvents.mockResolvedValue([{ id: 'evt_1', title: 'Gala', startsAt: '2099-01-01', status: 'draft', creatorDid: 'did:host' }]);
    render(await AdminPage());
    expect(screen.getByText('Gala')).toBeTruthy();
    expect(screen.getByText('did:host')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export Events' }).getAttribute('href')).toBe('/events/api/admin/events/export.csv');
    expect(pageMocks.requireAdmin).toHaveBeenCalled();
  });

  it('renders creator dashboard panels and editing controls', async () => {
    render(await EventAdminPage(route));
    expect(screen.getByRole('heading', { name: 'Test Meetup' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Guests/ })).toBeTruthy();
  });

  it('lets authorized co-hosts view the dashboard without creator mutation controls', async () => {
    pageMocks.isEventOrganizer.mockResolvedValue({ authorized: true, role: 'cohost' });
    render(await EventAdminPage(route));
    expect(screen.getByRole('heading', { name: 'Test Meetup' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
  });

  it('renders hard-identity creation and prefilled edit forms', async () => {
    render(await CreatePage());
    expect(screen.getByRole('heading', { name: 'Create Event', level: 1 })).toBeTruthy();
    expect(cardRail.getCardRailReadiness).toHaveBeenCalledWith('did:imajin:creator');
    expect(screen.getAllByRole('link', { name: 'Set up card payments' })).toHaveLength(2);
  });

  it('renders the edit form without signing keys or arbitrary metadata', async () => {
    render(await EditPage(route));
    expect(screen.getByRole('heading', { name: 'Edit Event', level: 1 })).toBeTruthy();
    expect(globalThis.document.body.innerHTML).not.toContain('super-secret-key');
    expect(globalThis.document.body.innerHTML).not.toContain('secret:');
    expect(screen.getByText(/No supported attribution manifest/)).toBeTruthy();
  });

  it('opens an event fee manifest in the organizer attribution panel', async () => {
    pageMocks.getEventWithTicketTypes.mockResolvedValue({
      event: makeEventRow({ metadata: { fair: feeManifestFixture(), privateNotes: 'DO_NOT_RENDER' } }),
      ticketTypes: [],
    });
    render(await EditPage(route));
    expect(screen.getByText('Event fee manifest')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save attribution' })).toBeTruthy();
    expect(screen.queryByText(/No supported attribution manifest/)).toBeNull();
    expect(globalThis.document.body.innerHTML).not.toContain('DO_NOT_RENDER');
    expect(globalThis.document.body.innerHTML).not.toContain('super-secret-key');
  });
});

describe('safe form DTOs', () => {
  it('keeps allowed null fields and excludes signing material and metadata', () => {
    const view = eventFormView(makeEventRow({ endsAt: new Date('2099-12-02'), emtEmail: 'pay@example.test' }));
    expect(view.endsAt).toBe('2099-12-02T00:00:00.000Z');
    expect(view.emtEmail).toBe('pay@example.test');
    expect(JSON.stringify(view)).not.toContain('super-secret-key');
    expect(view).not.toHaveProperty('metadata');
  });

  it('projects hidden tier settings only after the organizer gate', () => {
    const tier = tierFormView(makeTierRow({ accessCode: 'VIP', currency: null, perks: ['VIP'], sold: 2 }) as unknown as TicketTypeWithAvailability);
    expect(tier).toMatchObject({ accessCode: 'VIP', currency: 'CAD', perks: ['VIP'], sold: 2 });
    const empty = tierFormView(makeTierRow({ perks: null, sold: null }) as unknown as TicketTypeWithAvailability);
    expect(empty.perks).toEqual([]);
    expect(empty.sold).toBe(0);
  });
});
