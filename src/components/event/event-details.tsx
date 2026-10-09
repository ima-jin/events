import type { ReactNode } from 'react';
import { describeLocation, formatEventSchedule, type PublicEventView } from '@/lib/public-event';
import { Countdown } from './countdown';
import { ShareButton } from './share-button';

function InfoCard({ icon, label, children }: Readonly<{ icon: string; label: string; children: ReactNode }>) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-gray-800 p-4">
      <div className="text-2xl" aria-hidden="true">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-sm text-gray-400">{label}</div>
        {children}
      </div>
    </div>
  );
}

function ScheduleCard({ event }: Readonly<{ event: PublicEventView }>) {
  const { date, time, endTime, endDate } = formatEventSchedule(event.startsAt, event.endsAt, event.timezone);
  const end = endTime ? [endDate, endTime].filter(Boolean).join(', ') : null;
  return (
    <InfoCard icon="📅" label="Date & Time">
      <div className="font-semibold">{date}</div>
      <div className="text-sm text-gray-400">
        {time}
        {end && ` — ${end}`}
      </div>
    </InfoCard>
  );
}

function LocationCard({ event }: Readonly<{ event: PublicEventView }>) {
  const { icon, title, lines } = describeLocation(event);
  return (
    <InfoCard icon={icon} label="Location">
      <div className="truncate font-semibold">{title}</div>
      {lines.map((line) => (
        <div key={line} className="truncate text-sm text-gray-400">{line}</div>
      ))}
    </InfoCard>
  );
}

/** Title, schedule, location, countdown (upcoming events only) and description. */
export function EventDetails({ event, isUpcoming }: Readonly<{ event: PublicEventView; isUpcoming: boolean }>) {
  return (
    <section className="mb-6 rounded-2xl bg-gray-800/50 p-6 shadow-lg md:p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <h1 className="flex-1 text-3xl font-bold leading-tight md:text-5xl">{event.title}</h1>
        <ShareButton />
      </div>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <ScheduleCard event={event} />
        <LocationCard event={event} />
      </div>
      {isUpcoming && (
        <div className="mb-6">
          <Countdown targetDate={event.startsAt} />
        </div>
      )}
      {event.description && <p className="whitespace-pre-line text-gray-300">{event.description}</p>}
    </section>
  );
}
