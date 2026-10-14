'use client';

import { useState } from 'react';
import { formatMoney, identityLabel, INPUT_CLASS, organizerPath, PANEL_CLASS } from './organizer-data';
import { PanelState } from './panel-state';
import { useOrganizerData } from './use-organizer-data';
import { GuestActions } from './guest-actions';

export interface OrganizerGuest {
  id: string;
  status: string;
  ownerDid: string | null;
  pricePaid: number | null;
  currency: string | null;
  ticketType: string;
  paymentMethod: string | null;
  paymentId: string | null;
  registrationStatus: string | null;
  attendeeName: string | null;
  resolvedName: string | null;
  resolvedEmail: string | null;
  guestOf: string | null;
  usedAt: string | null;
  lastEmailSentAt: string | null;
  profile: { name: string | null; handle: string | null; email: string | null } | null;
}

function guestName(guest: OrganizerGuest): string {
  return identityLabel(guest.resolvedName || guest.attendeeName || guest.profile?.name, guest.profile?.handle, guest.resolvedEmail || guest.profile?.email, guest.ownerDid);
}

function matchesGuest(guest: OrganizerGuest, search: string, status: string, includeCancelled: boolean): boolean {
  if (!includeCancelled && (guest.status === 'cancelled' || guest.status === 'refunded')) return false;
  if (status === 'confirmed' && !['valid', 'used', 'sold'].includes(guest.status)) return false;
  if (status && status !== 'confirmed' && guest.status !== status) return false;
  return [guestName(guest), guest.resolvedEmail, guest.profile?.email, guest.profile?.handle, guest.ownerDid, guest.id, guest.ticketType]
    .some((value) => value?.toLowerCase().includes(search.toLowerCase()));
}

export function GuestList({ eventId, isCreator = false }: Readonly<{ eventId: string; isCreator?: boolean }>) {
  const state = useOrganizerData<{ guests: OrganizerGuest[] }>(organizerPath(eventId, '/guests'));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('confirmed');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const guests = state.data?.guests ?? [];
  const filtered = guests.filter((guest) => matchesGuest(guest, search, status, includeCancelled));
  const exportPath = organizerPath(eventId, `/guests/export.csv?includeCancelled=${includeCancelled ? '1' : '0'}`);
  function markRefundPending(ticketId: string) {
    setStatus('refund_pending');
    state.setData((current) => current && ({
      guests: current.guests.map((guest) => guest.id === ticketId ? { ...guest, status: 'refund_pending' } : guest),
    }));
  }
  function changeStatus(value: string) {
    setStatus(value);
    if (value === 'cancelled' || value === 'refunded') setIncludeCancelled(true);
  }
  function changeIncludeCancelled(checked: boolean) {
    setIncludeCancelled(checked);
    if (checked) setStatus('');
  }

  return <section className={PANEL_CLASS} aria-label="Guest list">
    <h2 className="mb-4 text-xl font-semibold">Guests</h2>
    <PanelState {...state} label="guests" />
    {state.data && <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label>Search guests <input className={INPUT_CLASS} type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Guest status <select className={INPUT_CLASS} value={status} onChange={(event) => changeStatus(event.target.value)}>
          <option value="confirmed">Confirmed tickets</option>
          <option value="">All statuses</option>
          {[...new Set(guests.map((guest) => guest.status))].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label><input type="checkbox" checked={includeCancelled} onChange={(event) => changeIncludeCancelled(event.target.checked)} /> Include cancelled / refunded</label>
        <a className="text-orange-600 underline" href={exportPath}>Export Guests CSV</a>
      </div>
      <p className="mb-3 text-sm">{filtered.length} of {guests.length} guests shown</p>
      {guests.length === 0 && <p>No guests yet. Ticket holders will appear here.</p>}
      {guests.length > 0 && filtered.length === 0 && <p>No guests match your filters.</p>}
      {filtered.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left">
        <thead><tr>{['Guest', 'Ticket', 'Status', 'Payment', 'Registration', 'Actions'].map((label) => <th className="p-2" key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{filtered.map((guest) => <tr key={guest.id} className="border-t border-gray-200 dark:border-gray-700">
          <td className="p-2"><p>{guestName(guest)}</p><p className="text-sm text-gray-500">{guest.resolvedEmail || guest.profile?.email}</p>{guest.guestOf && <p className="text-sm">Guest of {guest.guestOf}</p>}</td>
          <td className="p-2">{guest.ticketType}<p className="text-xs text-gray-500">{guest.id}</p></td>
          <td className="p-2">{guest.status}</td>
          <td className="p-2">{guest.paymentMethod || 'Not recorded'} · {formatMoney(guest.pricePaid, guest.currency)}<p className="text-xs text-gray-500">{guest.paymentId}</p></td>
          <td className="p-2">{guest.registrationStatus || 'Not required'}</td>
          <td className="p-2"><GuestActions eventId={eventId} guest={guest} isCreator={isCreator} onChanged={state.retry} onRefundPending={() => markRefundPending(guest.id)} /></td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </section>;
}
