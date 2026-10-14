'use client';

import { useState } from 'react';
import { formatMoney, identityLabel, INPUT_CLASS, organizerPath, PANEL_CLASS } from './organizer-data';
import { PanelState } from './panel-state';
import { useOrganizerData } from './use-organizer-data';
import { SaleActions } from './sale-actions';

export interface OrganizerSale {
  orderId: string;
  buyerDid: string | null;
  buyerName: string | null;
  buyerHandle: string | null;
  buyerEmail: string | null;
  ticketType: string;
  quantity: number;
  amountTotal: number;
  currency: string;
  paymentMethod: string | null;
  purchasedAt: string | null;
  status: string;
}

function SalesSummary({ sales }: Readonly<{ sales: readonly OrganizerSale[] }>) {
  const currencies = new Map<string, { total: number; orders: number }>();
  for (const sale of sales) {
    const summary = currencies.get(sale.currency) ?? { total: 0, orders: 0 };
    summary.total += sale.amountTotal;
    summary.orders += 1;
    currencies.set(sale.currency, summary);
  }
  return <div className="my-4 flex flex-wrap gap-6">
    <p>Total orders: {sales.length}</p>
    {[...currencies].map(([currency, summary]) => <div key={currency}>
      <p>{currency} total: {formatMoney(summary.total, currency)}</p>
      <p>{currency} average order: {formatMoney(summary.total / summary.orders, currency)}</p>
    </div>)}
  </div>;
}

export function SalesTab({ eventId }: Readonly<{ eventId: string }>) {
  const state = useOrganizerData<{ sales: OrganizerSale[] }>(organizerPath(eventId, '/sales'));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const sales = state.data?.sales ?? [];
  const filtered = sales.filter((sale) => {
    if (status && sale.status !== status) return false;
    return [sale.buyerName, sale.buyerHandle, sale.buyerEmail, sale.buyerDid, sale.orderId, sale.ticketType]
      .some((value) => value?.toLowerCase().includes(search.toLowerCase()));
  });
  return <section className={PANEL_CLASS} aria-label="Sales report">
    <h2 className="text-xl font-semibold">Sales</h2>
    <PanelState {...state} label="sales" />
    {state.data && <>
      <SalesSummary sales={sales} />
      <div className="mb-4 flex flex-wrap gap-3">
        <label>Search sales <input className={INPUT_CLASS} type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Sale status <select className={INPUT_CLASS} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {[...new Set(sales.map((sale) => sale.status))].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <a className="text-orange-600 underline" href={organizerPath(eventId, '/sales/export?format=csv')}>Export Sales CSV</a>
      </div>
      {sales.length === 0 && <p>No sales yet. Purchases will appear here.</p>}
      {sales.length > 0 && filtered.length === 0 && <p>No sales match your filters.</p>}
      {filtered.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left">
        <thead><tr>{['Buyer', 'Tickets', 'Amount', 'Status', 'Payment', 'Date', 'Actions'].map((label) => <th className="p-2" scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{filtered.map((sale) => <tr key={sale.orderId} className="border-t border-gray-200 dark:border-gray-700">
          <td className="p-2">{identityLabel(sale.buyerName, sale.buyerHandle, sale.buyerEmail, sale.buyerDid)}<p className="text-xs text-gray-500">{sale.orderId}</p></td>
          <td className="p-2">{sale.quantity} × {sale.ticketType}</td>
          <td className="p-2">{formatMoney(sale.amountTotal, sale.currency)}</td>
          <td className="p-2">{sale.status}</td>
          <td className="p-2">{sale.paymentMethod || 'Not recorded'}</td>
          <td className="p-2">{sale.purchasedAt ? new Date(sale.purchasedAt).toLocaleString('en-CA') : '—'}</td>
          <td className="p-2"><SaleActions sale={sale} onChanged={state.retry} /></td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </section>;
}
