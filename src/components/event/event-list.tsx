import Link from 'next/link';
import { formatEventSchedule, type PublicEventView } from '@/lib/public-event';

function EventListItem({ event }: Readonly<{ event: PublicEventView }>) {
  const { date, time } = formatEventSchedule(event.startsAt, null, event.timezone);
  const [from, to] = event.theme.gradient;

  return (
    <li>
      <Link href={`/e/${event.id}`} className="flex items-center gap-4 rounded-xl border border-gray-800 p-4 transition hover:border-orange-500/50">
        <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-2xl ${from} ${to}`} aria-hidden="true">
          {event.theme.emoji}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{event.title}</span>
          <span className="block text-sm text-gray-400">{date} · {time}</span>
          {event.city && <span className="block truncate text-sm text-gray-500">{event.city}</span>}
        </span>
      </Link>
    </li>
  );
}

/** Upcoming public events; invite-only events are never listed. */
export function EventList({ events }: Readonly<{ events: PublicEventView[] }>) {
  if (events.length === 0) {
    return <p className="text-gray-400">No upcoming events right now.</p>;
  }
  return (
    <ul className="space-y-3">
      {events.map((event) => (
        <EventListItem key={event.id} event={event} />
      ))}
    </ul>
  );
}
