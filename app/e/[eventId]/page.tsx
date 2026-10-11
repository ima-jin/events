import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EventDetails } from '@/components/event/event-details';
import { EventHero, StatusBanner } from '@/components/event/event-hero';
import { TicketsCard } from '@/components/event/tickets-card';
import { withBasePath } from '@/lib/base-path';
import { getViewer, loadPublicEvent } from '@/lib/load-public-event';
import { isHiddenStatus, type PublicEventView } from '@/lib/public-event';

// Always fresh: ticket availability and event edits change constantly.
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ invite?: string }>;
}

const DESCRIPTION_LIMIT = 200;

function absoluteUrl(path: string): string {
  if (path.startsWith('http')) return path;
  return `${process.env.NEXT_PUBLIC_APP_URL ?? ''}${path}`;
}

function describe(event: PublicEventView): string {
  if (!event.description) return `Join us for ${event.title}`;
  const clipped = event.description.slice(0, DESCRIPTION_LIMIT);
  return clipped.length < event.description.length ? `${clipped}...` : clipped;
}

export async function generateMetadata({ params }: Readonly<PageProps>): Promise<Metadata> {
  const { eventId } = await params;
  const loaded = await loadPublicEvent(eventId);
  if (!loaded || isHiddenStatus(loaded.event.status)) return { title: 'Event Not Found' };

  const { event } = loaded;
  const description = describe(event);
  const images = event.imageUrl ? [{ url: absoluteUrl(event.imageUrl), width: 1200, height: 630 }] : undefined;
  return {
    title: event.title,
    description,
    openGraph: {
      title: event.title,
      description,
      url: absoluteUrl(withBasePath(`/e/${event.id}`)),
      type: 'website',
      images,
    },
    twitter: { card: 'summary_large_image', title: event.title, description },
  };
}

export default async function EventPage({ params, searchParams }: Readonly<PageProps>) {
  const { eventId } = await params;
  const { invite } = await searchParams;

  const loaded = await loadPublicEvent(eventId);
  if (!loaded) notFound();

  const viewer = await getViewer();
  const { event, tiers, hasHiddenTiers, creatorDid } = loaded;
  const isCreator = viewer?.did === creatorDid;
  if (isHiddenStatus(event.status) && !isCreator) notFound();

  const isUpcoming = new Date(event.startsAt) > new Date();
  const canBuy = event.status === 'published' && tiers.length > 0;

  return (
    <>
      <div className="mx-auto max-w-5xl px-4 pb-20 md:pb-8">
        <EventHero event={event} />
        <StatusBanner status={event.status} />
        <EventDetails event={event} isUpcoming={isUpcoming} />
        <TicketsCard event={event} tiers={tiers} hasHiddenTiers={hasHiddenTiers} invite={invite} isAuthenticated={viewer !== null} />
      </div>
      {canBuy && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-800 bg-gray-900 px-4 py-3 shadow-lg md:hidden">
          <a href="#tickets" className="block w-full rounded-lg bg-orange-500 px-8 py-3 text-center font-semibold text-white transition-colors hover:bg-orange-600">
            Get Tickets
          </a>
        </div>
      )}
    </>
  );
}
