// @vitest-environment jsdom
/** Render + interaction tests for the presentational event components (src/components/event/*). */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Countdown, calculateTimeLeft } from '@/components/event/countdown';
import { EventDetails } from '@/components/event/event-details';
import { EventHero, StatusBanner } from '@/components/event/event-hero';
import { EventList } from '@/components/event/event-list';
import { ShareButton } from '@/components/event/share-button';
import { TicketsCard } from '@/components/event/tickets-card';
import { makeEventView, makeTier } from '../support/ui-support';

describe('calculateTimeLeft', () => {
  const NOW = Date.parse('2030-01-01T00:00:00Z');

  it('splits the remaining time into days, hours, minutes and seconds', () => {
    expect(calculateTimeLeft('2030-01-03T04:05:06Z', NOW)).toEqual({ days: 2, hours: 4, minutes: 5, seconds: 6 });
  });

  it('is null once the target has passed', () => {
    expect(calculateTimeLeft('2029-12-31T00:00:00Z', NOW)).toBeNull();
    expect(calculateTimeLeft('2030-01-01T00:00:00Z', NOW)).toBeNull();
  });
});

describe('Countdown', () => {
  it('ticks down every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    render(<Countdown targetDate="2030-01-01T00:01:05Z" />);

    expect(screen.getByText('Event starts in')).toBeTruthy();
    expect(screen.getByText('05')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('03')).toBeTruthy();
  });

  it('announces that the event is happening once the time has come', () => {
    render(<Countdown targetDate="2000-01-01T00:00:00Z" />);

    expect(screen.getByText(/Event is happening now/)).toBeTruthy();
  });

  it('accepts a custom label', () => {
    render(<Countdown targetDate="2099-01-01T00:00:00Z" label="Doors open in" />);

    expect(screen.getByText('Doors open in')).toBeTruthy();
  });
});

describe('ShareButton', () => {
  it('copies the page URL, briefly confirms, then hides the confirmation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.spyOn(globalThis.navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<ShareButton />);

    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(writeText).toHaveBeenCalledWith(globalThis.location.href);
    expect(await screen.findByText('Copied!')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByText('Copied!')).toBeNull();
  });

  it('stays quiet when the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis.navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<ShareButton />);

    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(screen.queryByText('Copied!')).toBeNull();
  });
});

describe('EventHero / StatusBanner', () => {
  it('shows the themed emoji when there is no image, and the featured badge', () => {
    render(<EventHero event={makeEventView({ featured: true })} />);

    expect(screen.getByText('🎉')).toBeTruthy();
    expect(screen.getByText(/Featured/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows the event image when there is one', () => {
    render(<EventHero event={makeEventView({ imageUrl: 'https://cdn.example/poster.png' })} />);

    expect(screen.getByRole('img', { name: 'Test Meetup' })).toBeTruthy();
    expect(screen.queryByText(/Featured/)).toBeNull();
  });

  it.each([
    ['cancelled', /has been cancelled/],
    ['completed', /has ended/],
    ['paused', /is paused/],
  ])('shows a banner for %s events', (status, text) => {
    render(<StatusBanner status={status} />);

    expect(screen.getByRole('status').textContent).toMatch(text);
  });

  it('shows no banner for published events', () => {
    const { container } = render(<StatusBanner status="published" />);

    expect(container.innerHTML).toBe('');
  });
});

describe('EventDetails', () => {
  it('renders title, schedule, location, countdown and description', () => {
    render(<EventDetails event={makeEventView({ description: 'Bring a friend', endsAt: '2099-12-01T20:00:00.000Z' })} isUpcoming />);

    expect(screen.getByRole('heading', { level: 1, name: 'Test Meetup' })).toBeTruthy();
    expect(screen.getByText(/December 1, 2099/)).toBeTruthy();
    expect(screen.getByText('The Hall')).toBeTruthy();
    expect(screen.getByText('1 Main St')).toBeTruthy();
    expect(screen.getByText('Event starts in')).toBeTruthy();
    expect(screen.getByText('Bring a friend')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('omits the countdown and description when not applicable, and shows the end date for multi-day events', () => {
    render(<EventDetails event={makeEventView({ locationType: 'virtual', endsAt: '2099-12-02T20:00:00.000Z' })} isUpcoming={false} />);

    expect(screen.queryByText('Event starts in')).toBeNull();
    expect(screen.getByText('Virtual Event')).toBeTruthy();
    expect(screen.getByText(/Wednesday, December 2/)).toBeTruthy();
  });
});

describe('TicketsCard', () => {
  const props = { tiers: [makeTier()], hasHiddenTiers: false, isAuthenticated: false };

  it('renders the purchase UI for a published event', () => {
    render(<TicketsCard event={makeEventView()} {...props} />);

    expect(screen.getByRole('heading', { name: 'Tickets' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
  });

  it('withholds the purchase UI for invite-only events without an invite', () => {
    render(<TicketsCard event={makeEventView({ accessMode: 'invite_only' })} {...props} />);

    expect(screen.getByText('This event is invite-only')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'General' })).toBeNull();
  });

  it('shows tiers to invite-only visitors who arrive with an invite', () => {
    render(<TicketsCard event={makeEventView({ accessMode: 'invite_only' })} {...props} invite="INV" />);

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
  });

  it.each([
    ['cancelled', /was cancelled/],
    ['completed', /has ended/],
    ['draft', /not currently available/],
  ])('closes sales for %s events', (status, text) => {
    render(<TicketsCard event={makeEventView({ status })} {...props} />);

    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'General' })).toBeNull();
  });

  it('does not sell tickets for campaign events', () => {
    render(<TicketsCard event={makeEventView({ eventType: 'campaign' })} {...props} />);

    expect(screen.getByText(/Campaign pledges are not available/)).toBeTruthy();
  });
});

describe('EventList', () => {
  it('links each event to its page', () => {
    render(<EventList events={[makeEventView(), makeEventView({ id: 'evt_2', title: 'Other', city: null })]} />);

    expect(screen.getByRole('link', { name: /Test Meetup/ }).getAttribute('href')).toBe('/e/evt_1');
    expect(screen.getByRole('link', { name: /Other/ }).getAttribute('href')).toBe('/e/evt_2');
  });

  it('says so when there is nothing coming up', () => {
    render(<EventList events={[]} />);

    expect(screen.getByText('No upcoming events right now.')).toBeTruthy();
  });
});
