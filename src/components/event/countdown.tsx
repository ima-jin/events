'use client';

import { useEffect, useState } from 'react';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Time remaining until `targetDate`, or `null` once it has passed. */
export function calculateTimeLeft(targetDate: string, now: number = Date.now()): TimeLeft | null {
  const difference = new Date(targetDate).getTime() - now;
  if (difference <= 0) return null;
  return {
    days: Math.floor(difference / DAY),
    hours: Math.floor((difference / HOUR) % 24),
    minutes: Math.floor((difference / MINUTE) % 60),
    seconds: Math.floor((difference / SECOND) % 60),
  };
}

const CARD = 'rounded-2xl bg-gray-800 p-6 text-center shadow-lg';
const UNIT_LABELS = ['Days', 'Hours', 'Minutes', 'Seconds'] as const;

function Units({ values, className }: Readonly<{ values: Record<(typeof UNIT_LABELS)[number], string>; className: string }>) {
  return (
    <div className="flex justify-center gap-4 md:gap-8">
      {UNIT_LABELS.map((unit) => (
        <div key={unit} className="text-center">
          <div className={className}>{values[unit]}</div>
          <div className="mt-1 text-xs uppercase text-gray-500">{unit}</div>
        </div>
      ))}
    </div>
  );
}

const PLACEHOLDER = { Days: '--', Hours: '--', Minutes: '--', Seconds: '--' };

export function Countdown({ targetDate, label = 'Event starts in' }: Readonly<{ targetDate: string; label?: string }>) {
  // Computed after mount so server and client markup match (no hydration mismatch).
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setTimeLeft(calculateTimeLeft(targetDate));
    const timer = setInterval(() => setTimeLeft(calculateTimeLeft(targetDate)), SECOND);
    return () => clearInterval(timer);
  }, [targetDate]);

  if (mounted && !timeLeft) {
    return (
      <div className="rounded-2xl bg-gradient-to-r from-green-500 to-emerald-600 p-6 text-center text-2xl font-bold text-white shadow-lg">
        🎉 Event is happening now!
      </div>
    );
  }

  const pad = (value: number) => value.toString().padStart(2, '0');
  const values = timeLeft
    ? { Days: pad(timeLeft.days), Hours: pad(timeLeft.hours), Minutes: pad(timeLeft.minutes), Seconds: pad(timeLeft.seconds) }
    : PLACEHOLDER;

  return (
    <div className={CARD}>
      <p className="mb-4 text-sm uppercase tracking-wide text-gray-500">{label}</p>
      <Units values={values} className="bg-gradient-to-br from-orange-500 to-amber-600 bg-clip-text text-3xl font-bold text-transparent md:text-5xl" />
    </div>
  );
}
