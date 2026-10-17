// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaymentReadiness } from '@/components/organizer/payment-readiness';
import { EventStatusControls } from '@/components/organizer/event-status-controls';
import { organizerError, safeSetupUrl } from '@/components/organizer/request-error';
import { body, change, eventFixture, jsonResponse, mockFetch, push, refresh, renderForm, renderPanel, tierFixture } from '../support/organizer-ui-support';

const setupUrl = 'https://kernel.example/auth/connectors/stripe';
const unavailable = { cardEnabled: null, setupUrl };
const disconnected = { cardEnabled: false, setupUrl };

vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

describe('organizer payment guidance', () => {
  it('shows setup in the publish control and tier editor without blocking free forms', async () => {
    const { user } = renderForm({ mode: 'edit', event: eventFixture(), existingTickets: [tierFixture({ price: 0 })], cardRailReadiness: disconnected });
    expect(screen.getAllByRole('link', { name: 'Set up card payments' })).toHaveLength(2);
    expect(screen.getAllByText(/Free tickets are unaffected/)).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
    change('Price', '5');
    expect(screen.getAllByText(/Paid tickets need/)).toHaveLength(2);
    await user.click(screen.getByLabelText('Accept e-Transfer payments'));
    change('Payment email', 'seller@example.test');
    expect(screen.queryByText(/Paid tickets need/)).toBeNull();
    expect(screen.getAllByText(/e-Transfer is available/)).toHaveLength(2);
  });

  it('warns about legacy live paid events but never changes status on render', () => {
    const fetch = mockFetch({});
    renderPanel(<EventStatusControls eventId="evt_1" currentStatus="published" isCreator hasPaidTiers cardRailReadiness={disconnected} />);
    expect(screen.getByText(/It remains published/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('shows retry guidance when readiness is unavailable', () => {
    renderPanel(<PaymentReadiness readiness={unavailable} hasPaidTiers emtEnabled={false} />);
    expect(screen.getByText(/refresh this page/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Set up card payments' }).getAttribute('href')).toBe(setupUrl);
  });

  it('does not show a warning for a connected card account', () => {
    renderPanel(<PaymentReadiness readiness={{ cardEnabled: true, setupUrl }} hasPaidTiers emtEnabled={false} />);
    expect(screen.queryByLabelText('Payment readiness')).toBeNull();
  });

  it('does not warn legacy paid e-Transfer events', () => {
    renderPanel(<PaymentReadiness readiness={disconnected} hasPaidTiers emtEnabled published />);
    expect(screen.queryByText(/It remains published/)).toBeNull();
    expect(screen.getByText(/Buyers will not see a card button/)).toBeTruthy();
  });

  it('renders structured publish refusal with setup link and retries the same action', async () => {
    let refused = true;
    const fetch = mockFetch({ '/api/events': () => refused
      ? jsonResponse({ code: 'SELLER_NO_CARD_RAIL', error: 'DO_NOT_RENDER', setupUrl }, 409)
      : jsonResponse({ event: { status: 'published' } }) });
    const { user } = renderPanel(<EventStatusControls eventId="evt_1" currentStatus="draft" isCreator />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Paid tickets need');
    expect(screen.queryByText('DO_NOT_RENDER')).toBeNull();
    expect(screen.getByRole('link', { name: 'Set up card payments' }).getAttribute('href')).toBe(setupUrl);
    refused = false;
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByText('published')).toBeTruthy());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('renders retryable status errors without disabling retry', async () => {
    mockFetch({ '/api/events': jsonResponse({ code: 'CARD_RAIL_UNAVAILABLE', retryable: true, setupUrl }, 503) });
    const { user } = renderPanel(<EventStatusControls eventId="evt_1" currentStatus="draft" isCreator />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Please retry');
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('supersedes a stale negative snapshot after connecting and publishing, then requests fresh server props', async () => {
    let refused = true;
    mockFetch({ '/api/events': () => refused
      ? jsonResponse({ code: 'SELLER_NO_CARD_RAIL', setupUrl }, 409)
      : jsonResponse({ event: { status: 'published' } }) });
    const { user, rerender } = renderPanel(<EventStatusControls eventId="evt_1" currentStatus="draft" isCreator hasPaidTiers cardRailReadiness={disconnected} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    refused = false;
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByText(/It remains published/)).toBeNull();
    expect(screen.queryByLabelText('Payment readiness')).toBeNull();
    rerender(<EventStatusControls eventId="evt_1" currentStatus="published" isCreator hasPaidTiers cardRailReadiness={{ cardEnabled: true, setupUrl }} />);
    expect(screen.queryByLabelText('Payment readiness')).toBeNull();
  });

  it.each([{ paid: false, emtEnabled: false }, { paid: true, emtEnabled: true }])('does not infer card readiness from free/e-Transfer publication (%j)', async ({ paid, emtEnabled }) => {
    mockFetch({ '/api/events': jsonResponse({ event: { status: 'published' } }) });
    const { user, rerender } = renderPanel(<EventStatusControls eventId="evt_1" currentStatus="draft" isCreator hasPaidTiers={paid} emtEnabled={emtEnabled} cardRailReadiness={disconnected} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('Payment readiness')).toBeNull();
    rerender(<EventStatusControls eventId="evt_1" currentStatus="published" isCreator hasPaidTiers={paid} emtEnabled={emtEnabled} cardRailReadiness={{ cardEnabled: false, setupUrl }} />);
    expect(screen.getByRole('link', { name: 'Set up card payments' })).toBeTruthy();
    expect(screen.queryByText(/It remains published/)).toBeNull();
  });

  it('keeps draft and tier IDs after refused publication and retries without duplicate POSTs', async () => {
    let refused = true;
    const fetch = mockFetch({ '/api/events': (init) => {
      const input = body(init);
      if (init?.method === 'POST' && input.eventType) return jsonResponse({ event: { id: 'evt_kept' } }, 201);
      if (init?.method === 'POST') return jsonResponse({ tier: { id: 'tier_kept' } }, 201);
      if (input.status === 'published' && refused) return jsonResponse({ code: 'SELLER_NO_CARD_RAIL', setupUrl }, 409);
      return jsonResponse({});
    } });
    const { user } = renderForm({ mode: 'create', cardRailReadiness: disconnected });
    change('Event title', 'Meetup');
    change('Start date and time', '2099-12-01T18:00');
    change('Price', '10');
    await user.selectOptions(screen.getByLabelText('Status'), 'published');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Paid tickets need');
    expect(push).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([, init]) => [init?.method, body(init).status])).toEqual([
      ['POST', 'draft'], ['PUT', undefined], ['POST', undefined], ['PUT', 'published'],
    ]);
    refused = false;
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/e/evt_kept'));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  });

  it('never unpublishes an existing event just to save its details or tiers', async () => {
    const fetch = mockFetch({ '/api/events': jsonResponse({}) });
    const { user } = renderForm({ mode: 'edit', event: eventFixture({ status: 'published' }), existingTickets: [tierFixture()] });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls.every(([, init]) => !('status' in body(init)))).toBe(true);
  });

  it('safely handles malformed and unsafe structured error fields', () => {
    for (const value of [null, {}, 42]) expect(organizerError(value).message).toContain('Unable to save');
    for (const value of [null, '', 'not-url', 'javascript:alert(1)', '/relative']) expect(safeSetupUrl(value)).toBeNull();
    expect(safeSetupUrl(setupUrl)).toBe(setupUrl);
    expect(organizerError({ code: 'SELLER_NO_CARD_RAIL', setupUrl: 'javascript:alert(1)' }).setupUrl).toBeNull();
  });
});
