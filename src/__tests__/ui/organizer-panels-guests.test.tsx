// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GuestList } from '@/components/organizer/guest-list';
import { EVENT_ID, deferredResponse, jsonResponse, makeGuest, mockFetch, renderPanel } from '../support/organizer-ui-support';

describe('organizer guests', () => {
  it('shows loading then an empty list', async () => {
    const resolve = deferredResponse();
    renderPanel(<GuestList eventId={EVENT_ID} />);
    expect(screen.getByRole('status').textContent).toContain('Loading guests');
    resolve(jsonResponse({ guests: [] }));
    expect(await screen.findByText(/No guests yet/)).toBeTruthy();
  });

  it('shows API errors and retries', async () => {
    let attempts = 0;
    mockFetch({ '/guests': () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ error: 'Forbidden' }, 403) : jsonResponse({ guests: [] });
    } });
    const { user } = renderPanel(<GuestList eventId={EVENT_ID} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Forbidden');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No guests yet/)).toBeTruthy();
  });

  it('excludes inactive tickets by default, displays fallback identities, payment and registration', async () => {
    mockFetch({ '/guests': jsonResponse({ guests: [
      makeGuest(), makeGuest({ id: 'cancelled', status: 'cancelled', resolvedName: 'Cancelled Guest' }),
      makeGuest({ id: 'refunded', status: 'refunded', resolvedName: 'Refunded Guest' }),
      makeGuest({ id: 'did-only', resolvedName: null, resolvedEmail: null, ownerDid: 'did:imajin:fallback' }),
    ] }) });
    const { user } = renderPanel(<GuestList eventId={EVENT_ID} />);
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByText('did:imajin:fallback')).toBeTruthy();
    expect(screen.queryByText('Cancelled Guest')).toBeNull();
    expect(screen.queryByText('Refunded Guest')).toBeNull();
    expect(screen.getAllByText('complete')).toHaveLength(2);
    expect(screen.getAllByText(/stripe · \$25.00/)).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Export Guests CSV' }).getAttribute('href')).toBe('/api/events/evt_1/guests/export.csv?includeCancelled=0');
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByText('Cancelled Guest')).toBeTruthy();
    expect(screen.getByText('Refunded Guest')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export Guests CSV' }).getAttribute('href')).toContain('includeCancelled=1');
  });

  it('searches guests and filters statuses with a no-match state', async () => {
    mockFetch({ '/guests': jsonResponse({ guests: [makeGuest(), makeGuest({ id: 'held', status: 'held', resolvedName: 'Lin' })] }) });
    const { user } = renderPanel(<GuestList eventId={EVENT_ID} />);
    await screen.findByText('Ada');
    await user.selectOptions(screen.getByLabelText('Guest status'), 'held');
    expect(screen.queryByText('Ada')).toBeNull();
    expect(screen.getByText('Lin')).toBeTruthy();
    await user.type(screen.getByLabelText('Search guests'), 'no-match');
    expect(screen.getByText('No guests match your filters.')).toBeTruthy();
  });
  it('defaults to valid, used and legacy sold tickets and explicitly reveals held/inactive statuses', async () => {
    const guests = [
      makeGuest(), makeGuest({ id: 'used', status: 'used', resolvedName: 'Used Guest' }),
      makeGuest({ id: 'sold', status: 'sold', resolvedName: 'Legacy Guest' }),
      makeGuest({ id: 'held', status: 'held', resolvedName: 'Held Guest' }),
      makeGuest({ id: 'cancelled', status: 'cancelled', resolvedName: 'Cancelled Guest' }),
      makeGuest({ id: 'refunded', status: 'refunded', resolvedName: 'Refunded Guest' }),
    ];
    mockFetch({ '/guests': jsonResponse({ guests }) });
    const { user } = renderPanel(<GuestList eventId={EVENT_ID} />);
    expect(await screen.findByText('3 of 6 guests shown')).toBeTruthy();
    expect(screen.getByText('Used Guest')).toBeTruthy();
    expect(screen.getByText('Legacy Guest')).toBeTruthy();
    expect(screen.queryByText('Held Guest')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Guest status'), 'held');
    expect(screen.getByText('Held Guest')).toBeTruthy();
    expect(screen.getByText('1 of 6 guests shown')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Guest status'), 'cancelled');
    expect(screen.getByText('Cancelled Guest')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });
});
