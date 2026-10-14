'use client';

import { useState } from 'react';
import type { OrganizerGuest } from './guest-list';
import { organizerPath, organizerRequest } from './organizer-data';

type GuestAction = 'check-in' | 'resend-email' | 'cancel' | 'refund' | 'mark-refund-sent';
interface ActionResult {
  manualRefundRequired?: boolean;
  refundEmail?: string;
  refundAmount?: string;
  refundCurrency?: string;
}
function canResend(guest: OrganizerGuest): boolean {
  if (guest.usedAt) return false;
  if (['cancelled', 'refunded', 'refund_pending'].includes(guest.status)) return false;
  return !guest.lastEmailSentAt || Date.now() - new Date(guest.lastEmailSentAt).getTime() >= 3 * 24 * 60 * 60 * 1000;
}

function availableActions(guest: OrganizerGuest, isCreator: boolean): { action: GuestAction; label: string }[] {
  const actions: { action: GuestAction; label: string }[] = [];
  if (guest.status === 'valid' && !guest.usedAt) actions.push({ action: 'check-in', label: 'Check In' });
  if (canResend(guest)) actions.push({ action: 'resend-email', label: 'Resend Email' });
  if (!isCreator) return actions;
  if (guest.status === 'held' || guest.status === 'available') actions.push({ action: 'cancel', label: 'Cancel Ticket' });
  if (guest.status === 'valid' && !guest.usedAt && (guest.pricePaid ?? 0) > 0) actions.push({ action: 'refund', label: 'Refund' });
  if (guest.status === 'refund_pending') actions.push({ action: 'mark-refund-sent', label: 'Mark Refund Sent' });
  return actions;
}

export function GuestActions({ eventId, guest, isCreator, onChanged, onRefundPending }: Readonly<{
  eventId: string;
  guest: OrganizerGuest;
  isCreator: boolean;
  onChanged: () => void;
  onRefundPending?: () => void;
}>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<GuestAction | null>(null);
  const [manualRefund, setManualRefund] = useState<ActionResult | null>(null);

  async function perform(action: GuestAction) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await organizerRequest<ActionResult>(
        organizerPath(eventId, `/tickets/${encodeURIComponent(guest.id)}/${action}`), { method: 'POST' },
      );
      setConfirmation(null);
      if (result.manualRefundRequired) {
        setManualRefund(result);
        onRefundPending?.();
      } else {
        setManualRefund(null);
        setNotice('Action completed.');
        onChanged();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ticket action failed.');
    } finally {
      setBusy(false);
    }
  }

  function request(action: GuestAction) {
    if (action === 'check-in' || action === 'resend-email') {
      perform(action);
      return;
    }
    setConfirmation(action);
  }

  return <div className="space-y-2">
    {guest.usedAt && <p>Checked In</p>}
    {manualRefund === null && <div className="flex flex-wrap gap-2">{availableActions(guest, isCreator).map(({ action, label }) =>
      <button key={action} type="button" disabled={busy} onClick={() => request(action)}>{busy ? 'Working…' : label}</button>)}</div>}
    {confirmation && <div role="alertdialog" aria-label={`Confirm ${confirmation}`}>
      <p>Confirm {confirmation} for ticket {guest.id}? Only continue if you intend this change.</p>
      <button type="button" disabled={busy} onClick={() => perform(confirmation)}>Confirm action</button>
      <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Keep ticket</button>
    </div>}
    {manualRefund && <div role="status">
      <p>Manual refund required: send {manualRefund.refundAmount} {manualRefund.refundCurrency} to {manualRefund.refundEmail || 'the buyer'} before marking it sent.</p>
      <button type="button" disabled={busy} onClick={() => request('mark-refund-sent')}>Mark Refund Sent</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
