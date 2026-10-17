'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { organizerPath, organizerRequest, PANEL_CLASS } from './organizer-data';
import type { CardRailReadiness } from '@/lib/card-rail';
import { PaymentReadiness } from './payment-readiness';
import { OrganizerRequestError } from './request-error';

const TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['published'], published: ['paused', 'cancelled', 'completed'],
  paused: ['published', 'cancelled'], cancelled: [], completed: [],
};
const LABELS: Record<string, string> = {
  published: 'Publish', paused: 'Pause', cancelled: 'Cancel Event', completed: 'Mark Complete',
};

export function EventStatusControls({ eventId, currentStatus, isCreator, cardRailReadiness, hasPaidTiers = false, emtEnabled = false }: Readonly<{
  eventId: string;
  currentStatus: string;
  isCreator: boolean;
  cardRailReadiness?: CardRailReadiness;
  hasPaidTiers?: boolean;
  emtEnabled?: boolean;
}>) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [supersededReadiness, setSupersededReadiness] = useState<CardRailReadiness>();

  async function transition(next: string) {
    setBusy(true);
    setError(null);
    setSetupUrl(null);
    try {
      const result = await organizerRequest<{ event: { status: string } }>(organizerPath(eventId), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
      });
      setStatus(result.event.status);
      setConfirmation(null);
      if (result.event.status === 'published') {
        // The gated mutation supersedes this snapshot, but does not prove card readiness:
        // free and e-Transfer publication can succeed without a card check.
        setSupersededReadiness(cardRailReadiness);
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update event status.');
      if (cause instanceof OrganizerRequestError) setSetupUrl(cause.setupUrl);
    } finally {
      setBusy(false);
    }
  }

  function requestTransition(next: string) {
    if (next === 'cancelled' || next === 'completed') {
      setConfirmation(next);
      return;
    }
    transition(next).catch(() => setError('Unable to update event status.'));
  }

  return <section className={PANEL_CLASS} aria-label="Event status">
    <p>Event status: <strong>{status}</strong></p>
    <PaymentReadiness readiness={cardRailReadiness === supersededReadiness ? undefined : cardRailReadiness}
      hasPaidTiers={hasPaidTiers} emtEnabled={emtEnabled} published={status === 'published'} />
    {isCreator && <div className="mt-3 flex flex-wrap gap-3">{(TRANSITIONS[status] ?? []).map((next) => {
      const label = status === 'paused' && next === 'published' ? 'Resume' : LABELS[next];
      return <button type="button" key={next} disabled={busy} onClick={() => requestTransition(next)}>{busy ? 'Updating…' : label}</button>;
    })}</div>}
    {confirmation && <div role="alertdialog" aria-label="Confirm status change" className="mt-3">
      <p>Change event status to {confirmation}? This cannot be undone.</p>
      <button type="button" disabled={busy} onClick={() => { transition(confirmation).catch(() => setError('Unable to update event status.')); }}>Confirm</button>
      <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Keep current status</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {setupUrl && <a href={setupUrl} className="underline">Set up card payments</a>}
  </section>;
}
