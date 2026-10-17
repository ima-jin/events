// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { saveForm, type SaveProgress } from '@/components/organizer-form/persistence';
import { initialDetails, newTier } from '@/components/organizer-form/model';
import { body, eventFixture, jsonResponse, mockFetch, push, renderForm, tierFixture } from '../support/organizer-ui-support';

const setupUrl = 'https://kernel.example/auth/connectors/stripe';
const paidTier = () => ({ ...newTier(), name: 'General', price: '10' });
const details = () => initialDetails({ mode: 'edit', event: eventFixture({ status: 'published' }) });
const progress = (): SaveProgress => ({ eventId: 'evt_edit', status: 'draft', tierIds: new Map(), uncertain: false });

describe('organizer publication persistence', () => {
  it('does not publish if any tier write refuses', async () => {
    const fetch = mockFetch({ '/api/events': (init) => init?.method === 'POST' ? jsonResponse({ error: 'invalid' }, 400) : jsonResponse({}) });
    await expect(saveForm(details(), [paidTier()], progress())).rejects.toThrow('Unable to save');
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls.every(([, init]) => body(init).status !== 'published')).toBe(true);
  });

  it.each([409, 503])('retains eventId from structured failed creation (%i) without another create POST', async (status) => {
    const state: SaveProgress = { tierIds: new Map(), uncertain: false };
    const code = status === 409 ? 'SELLER_NO_CARD_RAIL' : 'CARD_RAIL_UNAVAILABLE';
    const fetch = mockFetch({ '/api/events': (init) => {
      if (body(init).eventType) return jsonResponse({ code, eventId: 'evt_saved_draft', retryable: status === 503, setupUrl, privateKey: 'DO_NOT_KEEP' }, status);
      return jsonResponse({});
    } });
    await expect(saveForm(details(), [], state)).rejects.toThrow();
    expect(state.eventId).toBe('evt_saved_draft');
    expect(state.uncertain).toBe(false);
    expect(JSON.stringify(state)).not.toContain('DO_NOT_KEEP');
    await saveForm(details(), [], state);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls[1][0]).toBe('/api/events/evt_saved_draft');
  });

  it('does not retry an ambiguous create response or invent a confirmed event ID', async () => {
    const state: SaveProgress = { tierIds: new Map(), uncertain: false };
    const fetch = mockFetch({ '/api/events': jsonResponse({ error: 'DO_NOT_RENDER' }, 503) });
    await expect(saveForm(details(), [], state)).rejects.toThrow('Unable to save');
    expect(state.uncertain).toBe(true);
    await expect(saveForm(details(), [], state)).rejects.toThrow('uncertain');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([409, 503])('blocks create retries when a payment refusal omits the persisted draft ID (%i)', async (status) => {
    const state: SaveProgress = { tierIds: new Map(), uncertain: false };
    const fetch = mockFetch({ '/api/events': jsonResponse({ code: 'SELLER_NO_CARD_RAIL', eventId: 42 }, status) });
    await expect(saveForm(details(), [], state)).rejects.toThrow();
    expect(state.eventId).toBeUndefined();
    expect(state.uncertain).toBe(true);
    await expect(saveForm(details(), [], state)).rejects.toThrow('uncertain');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps unknown tier POST failures ambiguous and blocks retries', async () => {
    const state = progress();
    const fetch = mockFetch({ '/api/events': (init) => init?.method === 'POST' ? jsonResponse({}, 500) : jsonResponse({}) });
    await expect(saveForm(details(), [paidTier()], state)).rejects.toThrow('Unable to save');
    expect(state.uncertain).toBe(true);
    await expect(saveForm(details(), [paidTier()], state)).rejects.toThrow('uncertain');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('allows retry of explicit unavailable paid-tier refusal without confusing it with an ambiguous write', async () => {
    const state = progress();
    let unavailable = true;
    const fetch = mockFetch({ '/api/events': (init) => {
      if (init?.method === 'POST' && unavailable) return jsonResponse({ code: 'CARD_RAIL_UNAVAILABLE', retryable: true, setupUrl }, 503);
      if (init?.method === 'POST') return jsonResponse({ tier: { id: 'tier_confirmed' } }, 201);
      return jsonResponse({});
    } });
    const tier = paidTier();
    await expect(saveForm(details(), [tier], state)).rejects.toThrow('Please retry');
    expect(state.uncertain).toBe(false);
    unavailable = false;
    await saveForm(details(), [tier], state);
    expect(state.tierIds.get(tier.key)).toBe('tier_confirmed');
    expect(body(fetch.mock.calls.at(-1)?.[1]).status).toBe('published');
  });

  it.each([{ price: 0, emtEmail: null }, { price: 1000, emtEmail: 'seller@example.test' }])('publishes free/e-Transfer configurations without client-side card gating (%j)', async ({ price, emtEmail }) => {
    const fetch = mockFetch({ '/api/events': jsonResponse({}) });
    const { user } = renderForm({
      mode: 'edit', event: eventFixture({ emtEmail }), existingTickets: [tierFixture({ price })],
      cardRailReadiness: { cardEnabled: null, setupUrl },
    });
    await user.selectOptions(screen.getByLabelText('Status'), 'published');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([, init]) => body(init).status)).toEqual([undefined, undefined, 'published']);
    expect(body(fetch.mock.calls[0][1]).emtEmail).toBe(emtEmail);
  });

  it('surfaces a structured unavailable save error and permits a safe retry', async () => {
    let fail = true;
    mockFetch({ '/api/events': () => fail ? jsonResponse({ code: 'CARD_RAIL_UNAVAILABLE', retryable: true, setupUrl, error: 'DO_NOT_RENDER' }, 503) : jsonResponse({}) });
    const { user } = renderForm({ mode: 'edit', event: eventFixture(), existingTickets: [tierFixture()] });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Please retry');
    expect(screen.queryByText('DO_NOT_RENDER')).toBeNull();
    expect(screen.getByRole('link', { name: 'Set up card payments' }).getAttribute('href')).toBe(setupUrl);
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
  });
});
