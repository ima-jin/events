'use client';

import { useState } from 'react';
import { withBasePath } from '@/lib/base-path';
import type { OrganizerSale } from './sales-tab';
import { organizerRequest } from './organizer-data';

export function SaleActions({ sale, onChanged }: Readonly<{ sale: OrganizerSale; onChanged: () => void }>) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirmPayment() {
    setBusy(true);
    setError(null);
    try {
      await organizerRequest(withBasePath(`/api/orders/${encodeURIComponent(sale.orderId)}/confirm-payment`), { method: 'POST' });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Payment confirmation failed.');
    } finally {
      setBusy(false);
    }
  }
  if (sale.status !== 'pending' || sale.paymentMethod !== 'etransfer') return null;
  return <div>
    <button type="button" disabled={busy} onClick={() => setConfirming(true)}>Confirm e-Transfer</button>
    {confirming && <div role="alertdialog" aria-label="Confirm e-Transfer">
      <p>Have you received payment for this order? This confirms all held tickets.</p>
      <button type="button" disabled={busy} onClick={() => { confirmPayment().catch(() => setError('Payment confirmation failed.')); }}>{busy ? 'Confirming…' : 'Payment received'}</button>
      <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Not received</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
