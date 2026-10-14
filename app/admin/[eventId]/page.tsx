import { OrganizerDashboard } from '@/components/organizer/organizer-dashboard';
import { loadOrganizerPage } from '@/lib/organizer-page';

export const dynamic = 'force-dynamic';

export default async function EventAdminPage({ params }: Readonly<{ params: Promise<{ eventId: string }> }>) {
  const { eventId } = await params;
  const { event, ticketTypes, isCreator } = await loadOrganizerPage(eventId);
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
    <OrganizerDashboard
      eventId={eventId}
      title={String(event.title)}
      status={String(event.status || 'draft')}
      creatorDid={String(event.creatorDid)}
      startsAt={new Date(event.startsAt as string | Date).toISOString()}
      isCreator={isCreator}
      tiers={ticketTypes.map((tier) => ({
        id: tier.id,
        name: tier.name,
        price: tier.price,
        currency: tier.currency || 'CAD',
        quantity: tier.quantity,
        sold: tier.sold || 0,
      }))}
    />
    </div>
  );
}
