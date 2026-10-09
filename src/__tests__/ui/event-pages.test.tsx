// @vitest-environment jsdom
/**
 * Tests for the server-rendered pages: the public event page, the checkout
 * success page and the landing list. Server components are awaited and the
 * resulting element tree is rendered with RTL; the events service and the
 * session reader are the only seams that are doubled.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authClientDouble,
  eventsServiceDouble,
  givenEvent,
  makeEventRow,
  makeTierRow,
  resetPageMocks,
} from '../support/ui-support';

vi.mock('@/services/events-service', async () => (await import('../support/ui-support')).eventsServiceDouble);
vi.mock('@ima-jin/auth-client', async () => (await import('../support/ui-support')).authClientDouble);

import HomePage from '../../../app/page';
import SuccessPage from '../../../app/checkout/success/page';
import EventPage, { generateMetadata } from '../../../app/e/[eventId]/page';
import { getViewer, loadPublicEvent } from '@/lib/load-public-event';
import { ServiceError } from '@/services/errors';

const route = (eventId = 'evt_1', invite?: string) => ({
  params: Promise.resolve({ eventId }),
  searchParams: Promise.resolve(invite ? { invite } : {}),
});

async function renderEventPage(eventId = 'evt_1', invite?: string) {
  render(await EventPage(route(eventId, invite)));
}

beforeEach(() => {
  resetPageMocks();
  vi.unstubAllEnvs();
});

describe('loadPublicEvent / getViewer', () => {
  it('reads through the events service as the public audience and returns allow-listed views', async () => {
    givenEvent(makeEventRow({ emtEmail: 'pay@org.ca' }), [makeTierRow(), makeTierRow({ id: 'hidden', accessCode: 'VIP' })]);

    const loaded = await loadPublicEvent('evt_1');

    expect(eventsServiceDouble.getEventWithTicketTypes).toHaveBeenCalledWith('evt_1', 'public');
    expect(loaded?.tiers.map((t) => t.id)).toEqual(['tier_general']);
    expect(loaded?.hasHiddenTiers).toBe(true);
    expect(loaded?.creatorDid).toBe('did:imajin:creator');
    const serialised = JSON.stringify({ event: loaded?.event, tiers: loaded?.tiers });
    expect(serialised).not.toContain('super-secret-key');
    expect(serialised).not.toContain('pay@org.ca');
    expect(serialised).not.toContain('VIP');
  });

  it('answers null for an unknown event and rethrows anything else', async () => {
    eventsServiceDouble.getEventWithTicketTypes.mockRejectedValueOnce(new ServiceError('not_found', 'Event not found'));
    expect(await loadPublicEvent('nope')).toBeNull();

    eventsServiceDouble.getEventWithTicketTypes.mockRejectedValueOnce(new Error('db down'));
    await expect(loadPublicEvent('evt_1')).rejects.toThrow('db down');
  });

  it('getViewer returns the session user, or null when there is none or it cannot be read', async () => {
    authClientDouble.getSession.mockResolvedValueOnce({ did: 'did:imajin:me' });
    expect(await getViewer()).toEqual({ did: 'did:imajin:me' });

    authClientDouble.getSession.mockResolvedValueOnce(null);
    expect(await getViewer()).toBeNull();

    authClientDouble.getSession.mockRejectedValueOnce(new Error('no secret'));
    expect(await getViewer()).toBeNull();
  });
});

describe('EventPage', () => {
  it('renders the event and its purchase UI', async () => {
    givenEvent(makeEventRow({ description: 'A friendly meetup' }), [makeTierRow({ description: 'Main floor' })]);

    await renderEventPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Test Meetup' })).toBeTruthy();
    expect(screen.getByText('A friendly meetup')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add one General' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get Tickets' }).getAttribute('href')).toBe('#tickets');
  });

  it('never puts the private key, e-Transfer address or access codes in the markup', async () => {
    givenEvent(makeEventRow({ emtEmail: 'pay@org.ca' }), [makeTierRow(), makeTierRow({ id: 'hidden', accessCode: 'SECRETCODE' })]);

    await renderEventPage();

    expect(document.body.innerHTML).not.toContain('super-secret-key');
    expect(document.body.innerHTML).not.toContain('pay@org.ca');
    expect(document.body.innerHTML).not.toContain('SECRETCODE');
    expect(screen.getByLabelText('Have an access code?')).toBeTruthy();
  });

  it('404s for unknown events', async () => {
    eventsServiceDouble.getEventWithTicketTypes.mockRejectedValue(new ServiceError('not_found', 'Event not found'));

    await expect(EventPage(route('nope'))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it.each(['draft', 'paused'])('404s for %s events when the visitor is not the creator', async (status) => {
    givenEvent(makeEventRow({ status }));

    await expect(EventPage(route())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('lets the creator view a paused event, with its banner', async () => {
    givenEvent(makeEventRow({ status: 'paused' }));
    authClientDouble.getSession.mockResolvedValue({ did: 'did:imajin:creator' });

    await renderEventPage();

    expect(screen.getByText(/This event is paused/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Get Tickets' })).toBeNull();
  });

  it('closes sales and drops the mobile CTA for cancelled events', async () => {
    givenEvent(makeEventRow({ status: 'cancelled' }));

    await renderEventPage();

    expect(screen.getAllByText(/cancelled/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Get Tickets' })).toBeNull();
  });

  it('gates invite-only events behind the ?invite= token', async () => {
    givenEvent(makeEventRow({ accessMode: 'invite_only' }));

    await renderEventPage();
    expect(screen.getByText('This event is invite-only')).toBeTruthy();
  });

  it('shows the tiers to an invite-only visitor carrying a token', async () => {
    givenEvent(makeEventRow({ accessMode: 'invite_only' }));

    await renderEventPage('evt_1', 'INV9');

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
  });

  it('treats a signed-in viewer as authenticated (balance is requested)', async () => {
    givenEvent();
    authClientDouble.getSession.mockResolvedValue({ did: 'did:imajin:buyer' });
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ balance: 0 })));
    vi.stubGlobal('fetch', fetchSpy);

    await renderEventPage();

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/balance', expect.anything()));
  });
});

describe('generateMetadata', () => {
  it('builds title, description and OpenGraph data', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://events.test');
    givenEvent(makeEventRow({ imageUrl: '/uploads/poster.png' }));

    const meta = await generateMetadata(route());

    expect(meta.title).toBe('Test Meetup');
    expect(meta.description).toBe('A friendly meetup');
    expect(meta.openGraph).toMatchObject({ url: 'https://events.test/e/evt_1', images: [{ url: 'https://events.test/uploads/poster.png' }] });
  });

  it('truncates long descriptions, keeps absolute image URLs and falls back when there is no description', async () => {
    givenEvent(makeEventRow({ description: 'x'.repeat(250), imageUrl: 'https://cdn.example/p.png' }));
    const long = await generateMetadata(route());
    expect(String(long.description)).toBe(`${'x'.repeat(200)}...`);
    expect(long.openGraph).toMatchObject({ images: [{ url: 'https://cdn.example/p.png' }] });

    givenEvent(makeEventRow({ description: null }));
    expect((await generateMetadata(route())).description).toBe('Join us for Test Meetup');
  });

  it('does not reveal hidden or unknown events', async () => {
    givenEvent(makeEventRow({ status: 'draft' }));
    expect((await generateMetadata(route())).title).toBe('Event Not Found');

    eventsServiceDouble.getEventWithTicketTypes.mockRejectedValue(new ServiceError('not_found', 'Event not found'));
    expect((await generateMetadata(route('nope'))).title).toBe('Event Not Found');
  });
});

describe('SuccessPage', () => {
  const successRoute = (query: { session_id?: string; event?: string }) => ({ searchParams: Promise.resolve(query) });

  it('thanks the buyer, names the event and links back to it', async () => {
    givenEvent();

    render(await SuccessPage(successRoute({ event: 'evt_1', session_id: 'cs_test_1234567890abcdefghijkl' })));

    expect(screen.getByRole('heading', { name: "You've got a ticket!" })).toBeTruthy();
    expect(screen.getByText('Test Meetup')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Go to the Event/ }).getAttribute('href')).toBe('/e/evt_1');
    expect(screen.getByText(/Order: cs_test_1234567890ab\.\.\./)).toBeTruthy();
  });

  it('shows the event image when there is one', async () => {
    givenEvent(makeEventRow({ imageUrl: 'https://cdn.example/p.png' }));

    render(await SuccessPage(successRoute({ event: 'evt_1' })));

    expect(screen.getByRole('img', { name: 'Test Meetup' })).toBeTruthy();
  });

  it.each([
    ['no event id', {}],
    ['an unknown event', { event: 'nope' }],
  ])('falls back to browsing events for %s', async (_label, query) => {
    eventsServiceDouble.getEventWithTicketTypes.mockRejectedValue(new ServiceError('not_found', 'Event not found'));

    render(await SuccessPage(successRoute(query)));

    expect(screen.getByRole('link', { name: 'Browse Events' }).getAttribute('href')).toBe('/');
    expect(screen.queryByText(/Order:/)).toBeNull();
  });

  it('does not echo a draft event back', async () => {
    givenEvent(makeEventRow({ status: 'draft' }));

    render(await SuccessPage(successRoute({ event: 'evt_1' })));

    expect(screen.queryByText('Test Meetup')).toBeNull();
    expect(screen.getByRole('link', { name: 'Browse Events' })).toBeTruthy();
  });
});

describe('HomePage', () => {
  it('lists upcoming public events and skips invite-only ones', async () => {
    eventsServiceDouble.listEvents.mockResolvedValue([
      makeEventRow(),
      makeEventRow({ id: 'evt_secret', title: 'Secret Party', accessMode: 'invite_only' }),
    ]);

    render(await HomePage());

    expect(eventsServiceDouble.listEvents).toHaveBeenCalledWith({ audience: 'public', limit: 20, upcoming: true });
    expect(screen.getByRole('link', { name: /Test Meetup/ })).toBeTruthy();
    expect(screen.queryByText('Secret Party')).toBeNull();
  });
});
