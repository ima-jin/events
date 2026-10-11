import { EventList } from '@/components/event/event-list';
import { toPublicEventView } from '@/lib/public-event';
import { listEvents } from '@/services/events-service';

export const dynamic = 'force-dynamic';

const LIST_LIMIT = 20;

export default async function HomePage() {
  const rows = await listEvents({ audience: 'public', limit: LIST_LIMIT, upcoming: true });
  const events = rows.map(toPublicEventView).filter((event) => event.accessMode !== 'invite_only');

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="mb-6 text-2xl font-semibold text-white">Upcoming events</h1>
      <EventList events={events} />
    </div>
  );
}
