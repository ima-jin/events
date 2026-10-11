import { salesClosedMessage, type PublicEventView, type PublicTier } from '@/lib/public-event';
import { TicketPurchase } from '@/components/tickets/ticket-purchase';

interface TicketsCardProps {
  event: PublicEventView;
  tiers: PublicTier[];
  hasHiddenTiers: boolean;
  invite?: string;
  isAuthenticated: boolean;
}

function TicketsBody({ event, tiers, hasHiddenTiers, invite, isAuthenticated }: Readonly<TicketsCardProps>) {
  if (event.eventType === 'campaign') {
    return <p className="py-8 text-center text-gray-400">Campaign pledges are not available on this page yet.</p>;
  }
  // The checkout routes validate the invite token itself; the page only withholds the purchase UI without one.
  if (event.accessMode === 'invite_only' && !invite) {
    return (
      <div className="py-12 text-center">
        <p className="mb-2 text-lg font-semibold">This event is invite-only</p>
        <p className="text-sm text-gray-400">You need a valid invite link to purchase tickets.</p>
      </div>
    );
  }
  if (event.status !== 'published') {
    return <p className="py-8 text-center text-gray-400">{salesClosedMessage(event.status)}</p>;
  }
  return (
    <TicketPurchase
      eventId={event.id}
      tiers={tiers}
      hasHiddenTiers={hasHiddenTiers}
      invite={invite}
      etransferEnabled={event.etransferEnabled}
      isAuthenticated={isAuthenticated}
      maxTicketsPerOrder={event.maxTicketsPerOrder}
    />
  );
}

/** The "Tickets" card: invite gate, closed-sales message, or the purchase UI. */
export function TicketsCard(props: Readonly<TicketsCardProps>) {
  return (
    <section id="tickets" aria-labelledby="tickets-heading" className="rounded-2xl bg-gray-800/50 p-6 shadow-lg md:p-8">
      <h2 id="tickets-heading" className="mb-6 text-2xl font-bold md:text-3xl">Tickets</h2>
      <TicketsBody {...props} />
    </section>
  );
}
