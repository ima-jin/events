'use client';

import { useCallback, useState } from 'react';
import type { BuyerOrder, BuyerTicket } from '@/lib/buyer-tickets';
import { FairReceipt } from './fair-receipt';
import { TicketQr } from './ticket-qr';
import { TicketRegistration } from './ticket-registration';

export function formatOrderTotal(amount: number | null, currency: string | null): string {
  if (amount === null || !currency) return 'N/A';
  if (amount === 0) return 'Free';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
}

function OwnedTicket({ ticket, embedBaseUrl }: Readonly<{ ticket: BuyerTicket; embedBaseUrl: string | null }>) {
  const [complete, setComplete] = useState(false);
  const onComplete = useCallback(() => setComplete(true), []);
  const current = complete ? { ...ticket, registrationStatus: 'complete' } : ticket;
  return (
    <div>
      <TicketQr ticket={current} />
      <TicketRegistration ticket={current} embedBaseUrl={embedBaseUrl} onComplete={onComplete} />
    </div>
  );
}

export function OrderCard({ order, embedBaseUrl }: Readonly<{ order: BuyerOrder; embedBaseUrl: string | null }>) {
  const purchaseDate = order.purchasedAt
    ? new Date(order.purchasedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'N/A';
  return (
    <article aria-label={`Order ${order.id}`} className="rounded-xl border-2 border-orange-500 bg-orange-900/10 p-4 md:p-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold">{order.ticketTypeName}</h3>
          <p className="text-sm text-gray-400">{purchaseDate}</p>
          <p className="break-all font-mono text-xs text-gray-400">Order: {order.id}</p>
        </div>
        <p className="text-2xl font-bold text-orange-400">{formatOrderTotal(order.totalAmount, order.currency)}</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {order.tickets.map((ticket) => <OwnedTicket key={ticket.id} ticket={ticket} embedBaseUrl={embedBaseUrl} />)}
      </div>
      {order.fairSettlement && <FairReceipt settlement={order.fairSettlement} />}
    </article>
  );
}
