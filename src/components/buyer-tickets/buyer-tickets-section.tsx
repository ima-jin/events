'use client';

import type { ReactNode } from 'react';
import { readJson, type BuyerTicketsResponse } from './api';
import { useBuyerResource, useBuyerTab } from './hooks';
import { OrderCard } from './order-card';

const loadTickets = (path: string, signal: AbortSignal) => readJson<BuyerTicketsResponse>(path, { signal });

/** Mounted only for a signed-in viewer; all buyer data comes from this app's routes. */
export function BuyerTicketsSection({
  eventId, children, moreTicketsLabel = 'Buy More Tickets',
}: Readonly<{ eventId: string; children: ReactNode; moreTicketsLabel?: 'Buy More Tickets' | 'Get More Tickets' }>) {
  const resource = useBuyerResource(`/api/events/${encodeURIComponent(eventId)}/my-ticket`, loadTickets);
  const orders = resource.data?.orders ?? [];
  const tab = useBuyerTab(orders.length > 0 || resource.loading || resource.error !== null);
  const showTickets = tab.active === 'my-tickets';
  return (
    <div className="mt-8">
      <div role="tablist" aria-label="Event tickets" className="mb-6 flex gap-2 border-b border-gray-700">
        <button type="button" role="tab" id="my-tickets-tab" aria-selected={showTickets} aria-controls="my-tickets"
          onClick={() => tab.select('my-tickets')} className={`border-b-2 px-4 py-3 font-semibold ${showTickets ? 'border-orange-500 text-orange-400' : 'border-transparent text-gray-400'}`}>
          My Tickets
        </button>
        <button type="button" role="tab" id="buy-tickets-tab" aria-selected={!showTickets} aria-controls="buy-tickets"
          onClick={() => tab.select('buy-tickets')} className={`border-b-2 px-4 py-3 font-semibold ${showTickets ? 'border-transparent text-gray-400' : 'border-orange-500 text-orange-400'}`}>
          {orders.length > 0 ? moreTicketsLabel : 'Get Tickets'}
        </button>
      </div>
      <section id="my-tickets" role="tabpanel" aria-labelledby="my-tickets-tab" hidden={!showTickets} className="space-y-6">
        <h2 className="text-2xl font-bold">My Tickets</h2>
        {resource.loading && <output className="block">Loading your tickets…</output>}
        {resource.error && (
          <div role="alert">
            <p>Could not load your tickets: {resource.error}</p>
            <button type="button" onClick={resource.retry} className="text-orange-400 underline">Retry tickets</button>
          </div>
        )}
        {resource.data && orders.length === 0 && <p>You don&apos;t have any tickets for this event yet.</p>}
        {orders.map((order) => <OrderCard key={order.id} order={order} embedBaseUrl={resource.data?.registrationEmbedBaseUrl ?? null} />)}
        <button type="button" onClick={resource.retry} disabled={resource.loading} className="text-sm text-orange-400 underline">
          Refresh tickets
        </button>
      </section>
      <div id="buy-tickets" role="tabpanel" aria-labelledby="buy-tickets-tab" hidden={showTickets}>{children}</div>
    </div>
  );
}
