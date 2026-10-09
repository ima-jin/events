import Image from 'next/image';
import type { PublicEventView } from '@/lib/public-event';

/** Full-bleed event image, or the themed gradient + emoji when the event has none. */
export function EventHero({ event }: Readonly<{ event: PublicEventView }>) {
  const [from, to] = event.theme.gradient;

  return (
    <div className="relative -mx-4 mb-6 overflow-hidden md:mx-0 md:mb-8 md:rounded-2xl">
      {event.imageUrl ? (
        <div className="w-full bg-black/40">
          <Image
            src={event.imageUrl}
            alt={event.title}
            width={1200}
            height={630}
            unoptimized
            priority
            className="max-h-[400px] w-full object-contain md:max-h-[500px]"
          />
        </div>
      ) : (
        <div className={`flex h-[300px] w-full items-center justify-center bg-gradient-to-br md:h-[400px] ${from} ${to}`}>
          <span className="text-7xl md:text-9xl" aria-hidden="true">{event.theme.emoji}</span>
        </div>
      )}
      {event.featured && (
        <div className="absolute right-4 top-4 rounded-full bg-gray-900/95 px-3 py-1.5 text-xs font-semibold shadow-lg md:text-sm">
          ⭐ Featured
        </div>
      )}
    </div>
  );
}

const BANNERS: Record<string, { text: string; className: string }> = {
  cancelled: {
    text: 'This event has been cancelled.',
    className: 'border-red-700 bg-red-900/30 text-red-400',
  },
  completed: {
    text: 'This event has ended.',
    className: 'border-blue-700 bg-blue-900/30 text-blue-400',
  },
  paused: {
    text: 'This event is paused. It is not visible to the public.',
    className: 'border-yellow-700 bg-yellow-900/30 text-yellow-400',
  },
};

/** Banner for cancelled / completed / (creator-only) paused events; nothing otherwise. */
export function StatusBanner({ status }: Readonly<{ status: string }>) {
  const banner = BANNERS[status];
  if (!banner) return null;
  return (
    <div role="status" className={`mb-6 rounded-xl border px-4 py-3 text-center font-semibold ${banner.className}`}>
      {banner.text}
    </div>
  );
}
