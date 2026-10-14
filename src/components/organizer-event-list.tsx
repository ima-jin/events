import Link from 'next/link';

export interface OrganizerEventSummary {
  id: string;
  title: string;
  startsAt: string;
  status: string | null;
  creatorDid?: string | null;
  city?: string | null;
  ticketsSold?: number;
  revenueByCurrency?: readonly { currency: string; amount: number }[];
}

export function OrganizerEventList({ events }: Readonly<{ events: readonly OrganizerEventSummary[] }>) {
  if (events.length === 0) return <p className="rounded-xl border border-gray-800 p-8 text-gray-400">No events yet.</p>;
  return (
    <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {events.map((event) => (
        <li key={event.id} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold">{event.title}</h2>
          <p className="text-sm text-gray-400">{new Date(event.startsAt).toLocaleString()} · {event.city || 'Online / TBA'}</p>
          <p>{event.status || 'draft'}</p>
          {event.creatorDid && <p className="break-all text-sm text-gray-400">{event.creatorDid}</p>}
          {event.ticketsSold !== undefined && <p>{event.ticketsSold} tickets sold</p>}
          {event.revenueByCurrency?.map(({ currency, amount }) => (
            <p key={currency}>{new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(amount / 100)} {currency} revenue</p>
          ))}
          <div className="flex flex-wrap gap-4 text-orange-400">
            <Link href={`/admin/${encodeURIComponent(event.id)}`}>Manage event</Link>
            <Link href={`/e/${encodeURIComponent(event.id)}/edit`}>Edit</Link>
            <Link href={`/e/${encodeURIComponent(event.id)}`}>View event</Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
