import Link from 'next/link';
import Image from 'next/image';
import { loadPublicEvent } from '@/lib/load-public-event';
import { isHiddenStatus, type PublicEventView } from '@/lib/public-event';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ session_id?: string; event?: string }>;
}

const ORDER_REF_LENGTH = 20;

function SuccessHero({ event }: Readonly<{ event: PublicEventView | null }>) {
  return (
    <div className="relative -mx-4 mb-8 overflow-hidden sm:mx-0 sm:rounded-2xl">
      {event?.imageUrl ? (
        <Image src={event.imageUrl} alt={event.title} width={1200} height={320} unoptimized className="h-[240px] w-full object-cover md:h-[320px]" />
      ) : (
        <div className="h-[240px] w-full bg-gradient-to-br from-orange-500 to-amber-600 md:h-[320px]" />
      )}
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50">
        <h1 className="mb-2 text-3xl font-bold text-white md:text-4xl">You&apos;ve got a ticket!</h1>
        {event && <p className="text-xl font-semibold text-orange-300 md:text-2xl">{event.title}</p>}
      </div>
    </div>
  );
}

function NextStepsCard() {
  return (
    <div className="mb-8 rounded-2xl bg-gray-800 p-8 shadow-lg">
      <h2 className="mb-4 text-lg font-semibold">Here&apos;s what&apos;s waiting for you:</h2>
      <p className="text-left text-gray-400">
        <strong>Check your email</strong> — we sent a confirmation with your ticket details.
      </p>
    </div>
  );
}

const CTA_CLASS = 'inline-block rounded-lg bg-orange-500 px-8 py-3 text-lg font-semibold text-white transition hover:bg-orange-600';

export default async function SuccessPage({ searchParams }: Readonly<PageProps>) {
  const { session_id: sessionId, event: eventId } = await searchParams;
  const loaded = eventId ? await loadPublicEvent(eventId) : null;
  // Draft/paused events are never echoed back to an anonymous success-page visitor.
  const visible = loaded && !isHiddenStatus(loaded.event.status) ? loaded.event : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 text-center">
      <SuccessHero event={visible} />
      <NextStepsCard />
      <Link href={visible ? `/e/${visible.id}` : '/'} className={CTA_CLASS}>
        {visible ? 'Go to the Event →' : 'Browse Events'}
      </Link>
      {sessionId && <p className="mt-8 text-sm text-gray-500">Order: {sessionId.slice(0, ORDER_REF_LENGTH)}...</p>}
    </div>
  );
}
