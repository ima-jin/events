import { OrganizerDashboard } from '@/components/organizer/organizer-dashboard';
import { loadOrganizerPage } from '@/lib/organizer-page';
import { getCardRailReadiness } from '@/lib/card-rail';

export const dynamic = 'force-dynamic';

export default async function EventAdminPage({ params }: Readonly<{ params: Promise<{ eventId: string }> }>) {
  const { eventId } = await params;
  const { event, ticketTypes, isCreator } = await loadOrganizerPage(eventId);
  const cardRailReadiness = await getCardRailReadiness(String(event.creatorDid));
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
    <OrganizerDashboard
      eventId={eventId}
      title={String(event.title)}
      status={typeof event.status === 'string' ? event.status : 'draft'}
      creatorDid={String(event.creatorDid)}
      startsAt={new Date(event.startsAt as string | Date).toISOString()}
      isCreator={isCreator}
      cardRailReadiness={cardRailReadiness}
      emtEnabled={typeof event.emtEmail === 'string' && Boolean(event.emtEmail.trim())}
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
