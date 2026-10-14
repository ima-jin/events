import Link from 'next/link';
import { OrganizerEventList } from '@/components/organizer-event-list';
import { requirePageActor } from '@/lib/organizer-page';
import { listCreatorEvents } from '@/services/events-service';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const actor = await requirePageActor();
  const events = await listCreatorEvents(actor.did);
  const summaries = events.map((event) => {
    const revenue = new Map<string, number>();
    for (const tier of event.ticketTypes) {
      const currency = tier.currency || 'CAD';
      revenue.set(currency, (revenue.get(currency) || 0) + (tier.sold || 0) * tier.price);
    }
    return {
      id: event.id,
      title: event.title,
      startsAt: new Date(event.startsAt).toISOString(),
      status: event.statusBadge,
      city: event.city,
      ticketsSold: event.ticketsSold,
      revenueByCurrency: [...revenue].map(([currency, amount]) => ({ currency, amount })),
    };
  });
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <div><h1 className="text-3xl font-bold">My Events</h1><p className="text-gray-400">Manage your events and track ticket sales</p></div>
        <Link href="/create" className="rounded-lg bg-orange-500 px-4 py-2 font-semibold text-white">Create Event</Link>
      </div>
      <OrganizerEventList events={summaries} />
    </div>
  );
}
