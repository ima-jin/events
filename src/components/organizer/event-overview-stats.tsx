'use client';

import type { OrganizerGuest } from './guest-list';
import { formatMoney, organizerPath } from './organizer-data';
import { PanelState } from './panel-state';
import { useOrganizerData } from './use-organizer-data';

interface RevenueSummary {
  confirmed: number;
  held: number;
}

function summarizeRevenue(guests: readonly OrganizerGuest[]): Map<string, RevenueSummary> {
  const currencies = new Map<string, RevenueSummary>();
  for (const guest of guests) {
    const code = guest.currency || 'CAD';
    const totals = currencies.get(code) ?? { confirmed: 0, held: 0 };
    if (guest.status === 'valid' || guest.status === 'used') totals.confirmed += guest.pricePaid ?? 0;
    if (guest.status === 'held') totals.held += guest.pricePaid ?? 0;
    currencies.set(code, totals);
  }
  return currencies;
}

function eventDate(startsAt?: string): string {
  if (!startsAt) return 'Not provided';
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return 'Not provided';
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function EventOverviewStats({ eventId, startsAt }: Readonly<{ eventId: string; startsAt?: string }>) {
  const state = useOrganizerData<{ guests: OrganizerGuest[] }>(organizerPath(eventId, '/guests'));
  const guests = state.data?.guests ?? [];
  const totalSold = guests.filter((guest) => !['cancelled', 'refunded'].includes(guest.status)).length;
  const checkedIn = guests.filter((guest) => Boolean(guest.usedAt)).length;
  const currencies = summarizeRevenue(guests);
  return <div className="mb-4" aria-label="Event statistics">
    <PanelState {...state} label="statistics" />
    {state.data && <dl className="grid gap-4 md:grid-cols-3">
      <div><dt>Tickets Sold</dt><dd className="text-xl font-semibold">{totalSold}</dd></div>
      <div><dt>Checked In</dt><dd className="text-xl font-semibold">{checkedIn} / {totalSold}</dd></div>
      <div><dt>Event Date</dt><dd>{eventDate(startsAt)}</dd></div>
      {[...currencies].map(([currency, summary]) => <div key={currency}>
        <dt>{currency} Revenue</dt><dd>{formatMoney(summary.confirmed, currency)} confirmed</dd>
        <dt>{currency} Pending Revenue</dt><dd>{formatMoney(summary.held, currency)} pending</dd>
      </div>)}
    </dl>}
  </div>;
}
