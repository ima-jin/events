import { OrganizerEventList } from '@/components/organizer-event-list';
import { withBasePath } from '@/lib/base-path';
import { requirePageActor } from '@/lib/organizer-page';
import { listAdminEvents } from '@/services/admin-export-service';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  await requirePageActor('admin');
  const events = await listAdminEvents();
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Admin — Events</h1>
        <a href={withBasePath('/api/admin/events/export.csv')} className="rounded-lg bg-orange-500 px-4 py-2 font-semibold text-white">Export Events</a>
      </div>
      <p className="text-gray-400">{events.length} events on the network</p>
      <OrganizerEventList events={events} />
    </div>
  );
}
