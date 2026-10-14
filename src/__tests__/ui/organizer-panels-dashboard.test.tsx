// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrganizerDashboard } from '@/components/organizer/organizer-dashboard';
import { EventStatusControls } from '@/components/organizer/event-status-controls';
import { EventOverviewStats } from '@/components/organizer/event-overview-stats';
import { CREATOR_DID, EVENT_ID, jsonResponse, makeGuest, mockFetch, renderPanel } from '../support/organizer-ui-support';

describe('organizer dashboard', () => {
  it('switches tabs and lazy-loads their contents', async () => {
    const spy = mockFetch({
      '/guests': jsonResponse({ guests: [makeGuest()] }),
      '/sales': jsonResponse({ sales: [] }), '/cohosts': jsonResponse({ cohosts: [] }),
    });
    const { user } = renderPanel(<OrganizerDashboard eventId={EVENT_ID} title="Meetup" status="published" creatorDid={CREATOR_DID} isCreator={false} />);
    expect(screen.getByRole('heading', { name: 'Meetup' })).toBeTruthy();
    await screen.findByText('Tickets Sold');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Guests' }));
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Guests' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('tab', { name: 'Sales' }));
    expect(await screen.findByText(/No sales yet/)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Managers' }));
    expect(await screen.findByText('No co-hosts added yet.')).toBeTruthy();
  });

  it('uses PATCH status contract and confirms irreversible changes', async () => {
    const spy = mockFetch({ '/api/events': (init) => jsonResponse({ event: { status: JSON.parse(String(init?.body)).status } }) });
    const { user } = renderPanel(<EventStatusControls eventId={EVENT_ID} currentStatus="published" isCreator />);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ status: 'paused' });
    expect(spy.mock.calls[0][1]?.method).toBe('PATCH');
    await user.click(screen.getByRole('button', { name: 'Cancel Event' }));
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('cancelled')).toBeTruthy();
  });

  it('shows status failure and preserves existing transitions', async () => {
    mockFetch({ '/api/events': jsonResponse({ error: 'Status rejected' }, 400) });
    const { user } = renderPanel(<EventStatusControls eventId={EVENT_ID} currentStatus="draft" isCreator />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Status rejected');
    expect(screen.getByText('draft')).toBeTruthy();
  });
  it('renders ticket counts, checked-in totals, pending/confirmed revenue and date', async () => {
    mockFetch({ '/guests': jsonResponse({ guests: [
      makeGuest(), makeGuest({ id: 'used', status: 'used', usedAt: '2026-10-14', pricePaid: 1500 }),
      makeGuest({ id: 'held', status: 'held', pricePaid: 1000 }),
      makeGuest({ id: 'cancelled', status: 'cancelled', pricePaid: 8000 }),
      makeGuest({ id: 'refunded', status: 'refunded', pricePaid: 8000 }),
    ] }) });
    renderPanel(<EventOverviewStats eventId={EVENT_ID} startsAt="2026-10-14T12:00:00Z" />);
    const stats = within(screen.getByLabelText('Event statistics'));
    expect(await stats.findByText('3')).toBeTruthy();
    expect(stats.getByText('1 / 3')).toBeTruthy();
    expect(stats.getByText('$40.00 confirmed')).toBeTruthy();
    expect(stats.getByText('$10.00 pending')).toBeTruthy();
    expect(stats.getByText('Oct 14, 2026')).toBeTruthy();
  });
});
