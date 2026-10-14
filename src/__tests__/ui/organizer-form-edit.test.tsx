// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { body, change, eventFixture, jsonResponse, mockFetch, push, renderForm, tierFixture } from '../support/organizer-form-support';

describe('organizer edit form', () => {
  it('handles missing or invalid event load without exposing errors', () => {
    const { unmount } = renderForm({ mode: 'edit', loadError: 'SECRET' });
    expect(screen.getByRole('alert').textContent).toContain('Unable to load');
    expect(screen.queryByText('SECRET')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    unmount();
    renderForm({ mode: 'edit', event: eventFixture({ startsAt: 'invalid' }) });
    expect(screen.getByRole('alert').textContent).toContain('Unable to load');
  });

  it('preloads zoned dates and PUTs event then existing tiers while preserving untouched metadata', async () => {
    const fetch = mockFetch({ '/api/events': jsonResponse({ event: { privateKey: 'SECRET' } }) });
    const { user } = renderForm({
      mode: 'edit', event: eventFixture({ timezone: 'America/Toronto' }), existingTickets: [tierFixture()],
    });
    expect((screen.getByLabelText('Start date and time') as HTMLInputElement).value).toBe('2099-12-01T13:00');
    expect(screen.queryByRole('button', { name: 'Remove new tier' })).toBeNull();
    change('Price', '19.99');
    change('Perks (one per line)', 'Recording\nDinner');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/e/evt_edit'));
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'PUT']);
    const payload = body(fetch.mock.calls[0][1]);
    expect(payload).toMatchObject({ description: 'Original description', startsAt: '2099-12-01T18:00:00.000Z' });
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('chatEnabled');
    expect(body(fetch.mock.calls[1][1])).toMatchObject({ tierId: 'tier_existing', price: 1999, perks: ['Recording', 'Dinner'] });
  });

  it('enforces sold quantities, price/currency and append-only perks client-side', async () => {
    const fetch = mockFetch({});
    const { user } = renderForm({ mode: 'edit', event: eventFixture(), existingTickets: [tierFixture()] });
    const save = () => user.click(screen.getByRole('button', { name: 'Save changes' }));
    change('Quantity (blank means unlimited)', '1');
    await save();
    expect(screen.getByRole('alert').textContent).toContain('sold count');
    change('Quantity (blank means unlimited)', '2');
    change('Price', '21');
    await save();
    expect(screen.getByRole('alert').textContent).toContain('Prices can only decrease');
    change('Price', '20');
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    await save();
    expect(screen.getByRole('alert').textContent).toContain('Currency cannot change');
    await user.selectOptions(screen.getByLabelText('Currency'), 'CAD');
    change('Perks (one per line)', 'Dinner');
    await save();
    expect(screen.getByRole('alert').textContent).toContain('perks can only be added');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('captures new tier IDs across partial failures so retries never duplicate confirmed writes', async () => {
    let rejected = false;
    const fetch = mockFetch({
      '/api/events': (init) => {
        const input = body(init);
        if (init?.method === 'POST' && input.name === 'VIP') return jsonResponse({ tier: { id: 'tier_vip' } }, 201);
        if (init?.method === 'POST' && !rejected) { rejected = true; return jsonResponse({ error: 'SECRET' }, 400); }
        if (init?.method === 'POST') return jsonResponse({ tier: { id: 'tier_late' } }, 201);
        return jsonResponse({});
      },
    });
    const { user } = renderForm({ mode: 'edit', event: eventFixture(), existingTickets: [tierFixture()] });
    await user.click(screen.getByRole('button', { name: 'Add tier' }));
    const names = screen.getAllByLabelText('Tier name');
    fireEvent.change(names[1], { target: { value: 'VIP' } });
    await user.click(screen.getByRole('button', { name: 'Add tier' }));
    fireEvent.change(screen.getAllByLabelText('Tier name')[2], { target: { value: 'Late' } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to save'));
    expect(screen.getAllByRole('button', { name: 'Remove new tier' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const vipCreates = fetch.mock.calls.filter(([, init]) => init?.method === 'POST' && body(init).name === 'VIP');
    expect(vipCreates).toHaveLength(1);
    expect(fetch.mock.calls.some(([, init]) => body(init).tierId === 'tier_vip')).toBe(true);
  });

  it('shows saving state and rejects duplicate submit while request is in progress', async () => {
    let resolve: (response: Response) => void = () => {};
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetch = mockFetch({ '/api/events': () => pending });
    const { user } = renderForm({ mode: 'edit', event: eventFixture(), existingTickets: [tierFixture()] });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const button = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(jsonResponse({}));
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it('retries idempotent event PUT failures without creating tiers prematurely', async () => {
    let fails = true;
    const fetch = mockFetch({ '/api/events': () => fails ? jsonResponse({ error: 'SECRET' }, 500) : jsonResponse({}) });
    const { user } = renderForm({ mode: 'edit', event: eventFixture(), existingTickets: [tierFixture()] });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to save'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('SECRET')).toBeNull();
    fails = false;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'PUT')).toBe(true);
  });

  it('cancels editing to the existing event', async () => {
    const { user } = renderForm({ mode: 'edit', event: eventFixture(), existingTickets: [] });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(push).toHaveBeenCalledWith('/e/evt_edit');
  });
});
