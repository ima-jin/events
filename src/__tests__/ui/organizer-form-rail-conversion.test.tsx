// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { body, change, eventFixture, jsonResponse, mockFetch, push, renderForm, tierFixture } from '../support/organizer-ui-support';

describe('organizer live payment rail conversions', () => {
  it('confirms all persisted paid tiers free before disabling the last e-Transfer rail', async () => {
    const paidIds = new Set(['tier_existing', 'tier_vip']);
    const fetch = mockFetch({ '/api/events': (init) => {
      const input = body(init);
      if (typeof input.tierId === 'string' && input.price === 0) paidIds.delete(input.tierId);
      if ('emtEmail' in input && input.emtEmail === null && paidIds.size > 0) {
        return jsonResponse({ code: 'SELLER_NO_CARD_RAIL' }, 409);
      }
      return jsonResponse({});
    } });
    const { user } = renderForm({
      mode: 'edit', event: eventFixture({ status: 'published', emtEmail: 'seller@example.test' }),
      existingTickets: [tierFixture(), tierFixture({ id: 'tier_vip', name: 'VIP' })],
    });
    for (const input of screen.getAllByLabelText('Price')) fireEvent.change(input, { target: { value: '0' } });
    await user.click(screen.getByLabelText('Accept e-Transfer payments'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([, init]) => [body(init).tierId, body(init).emtEmail])).toEqual([
      ['tier_existing', undefined], ['tier_vip', undefined], [undefined, null],
    ]);
    expect(fetch.mock.calls.every(([, init]) => !('status' in body(init)))).toBe(true);
  });

  it('keeps the current rail when a free conversion refuses, and safely retries the confirmed conversions', async () => {
    let refused = true;
    const fetch = mockFetch({ '/api/events': (init) => {
      if (body(init).tierId === 'tier_vip' && refused) return jsonResponse({ error: 'Invalid tier' }, 400);
      return jsonResponse({});
    } });
    const { user } = renderForm({
      mode: 'edit', event: eventFixture({ status: 'published', emtEmail: 'seller@example.test' }),
      existingTickets: [tierFixture(), tierFixture({ id: 'tier_vip', name: 'VIP' })],
    });
    for (const input of screen.getAllByLabelText('Price')) fireEvent.change(input, { target: { value: '0' } });
    await user.click(screen.getByLabelText('Accept e-Transfer payments'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetch.mock.calls.every(([, init]) => !('emtEmail' in body(init)))).toBe(true);
    expect(push).not.toHaveBeenCalled();
    refused = false;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(body(fetch.mock.calls.at(-1)?.[1]).emtEmail).toBeNull();
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'PUT')).toBe(true);
  });

  it('enables e-Transfer before turning a live free tier paid', async () => {
    let railEnabled = false;
    const fetch = mockFetch({ '/api/events': (init) => {
      const input = body(init);
      if (input.emtEmail === 'seller@example.test') railEnabled = true;
      if (input.price === 1000 && !railEnabled) return jsonResponse({ code: 'SELLER_NO_CARD_RAIL' }, 409);
      return jsonResponse({});
    } });
    const { user } = renderForm({
      mode: 'edit', event: eventFixture({ status: 'published' }),
      existingTickets: [tierFixture({ price: 0, sold: 0 })],
    });
    change('Price', '10');
    await user.click(screen.getByLabelText('Accept e-Transfer payments'));
    change('Payment email', 'seller@example.test');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([, init]) => [body(init).emtEmail, body(init).price])).toEqual([
      ['seller@example.test', undefined], [undefined, 1000],
    ]);
  });
});
