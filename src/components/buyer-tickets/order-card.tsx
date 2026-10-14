'use client';

import { useState } from 'react';
import type { BuyerOrder } from '@/lib/buyer-tickets';
import { FairReceipt } from './fair-receipt';
import { TicketQr } from './ticket-qr';
import { TicketRegistration } from './ticket-registration';

export function formatOrderTotal(amount: number | null, currency: string | null): string {
  if (amount === null || !currency) return 'N/A';
  if (amount === 0) return 'Free';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
}


export function OrderCard({ order, embedBaseUrl }: Readonly<{ order: BuyerOrder; embedBaseUrl: string | null }>) {
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  const tickets = order.tickets.map((ticket) => completed[ticket.id] ? { ...ticket, registrationStatus: 'complete' } : ticket);
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
        {tickets.map((ticket) => <TicketQr key={ticket.id} ticket={ticket} />)}
      </div>
      {tickets.map((ticket) => (
        <TicketRegistration key={ticket.id} ticket={ticket} embedBaseUrl={embedBaseUrl}
          onComplete={() => setCompleted((previous) => ({ ...previous, [ticket.id]: true }))} />
      ))}
      {order.fairSettlement && <FairReceipt settlement={order.fairSettlement} />}
    </article>
  );
}
