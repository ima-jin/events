import { EventForm } from '@/components/organizer-form';
import { eventFormView, tierFormView } from '@/lib/organizer-form-view';
import { loadOrganizerPage } from '@/lib/organizer-page';

export const dynamic = 'force-dynamic';

export default async function EditPage({ params }: Readonly<{ params: Promise<{ eventId: string }> }>) {
  const { eventId } = await params;
  const { event, ticketTypes } = await loadOrganizerPage(eventId);
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
      <h1 className="text-3xl font-bold">Edit Event</h1>
      <EventForm mode="edit" event={eventFormView(event)} existingTickets={ticketTypes.map(tierFormView)} />
    </div>
  );
}
