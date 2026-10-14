import { EventForm } from '@/components/organizer-form';
import { requirePageActor } from '@/lib/organizer-page';

export const dynamic = 'force-dynamic';

export default async function CreatePage() {
  await requirePageActor('create');
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
      <h1 className="text-3xl font-bold">Create Event</h1>
      <EventForm mode="create" />
    </div>
  );
}
