'use client';

import Image from 'next/image';
import type { BuyerTicket } from '@/lib/buyer-tickets';
import { canPresentQr, readJson } from './api';
import { useBuyerResource } from './hooks';

const LABELS: Record<string, string> = {
  valid: 'Valid',
  used: 'Checked In',
  refunded: 'Refunded',
  refund_pending: 'Refund pending',
  held: 'Awaiting payment',
  available: 'Not activated',
  cancelled: 'Cancelled',
};

const loadQr = (path: string, signal: AbortSignal) => readJson<{ qrCodeDataUri: string }>(path, { signal });
function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function TicketQr({ ticket }: Readonly<{ ticket: BuyerTicket }>) {
  const path = canPresentQr(ticket) ? `/api/tickets/${encodeURIComponent(ticket.id)}/qr` : null;
  const qr = useBuyerResource(path, loadQr);
  const pending = ticket.registrationStatus === 'pending';
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-gray-700 p-3">
      <p className="font-medium">{ticket.ticketType?.name ?? 'Ticket'}</p>
      <p className="text-sm text-orange-400">{LABELS[ticket.status] ?? ticket.status}</p>
      {ticket.usedAt && <p className="text-xs text-gray-400">Checked in {timeAgo(ticket.usedAt)}</p>}
      {pending && <p className="text-sm text-amber-400">Registration Required</p>}
      {qr.loading && <p role="status">Loading QR code…</p>}
      {qr.error && (
        <div role="alert">
          <p>{qr.error}</p>
          <button type="button" onClick={qr.retry} className="text-orange-400 underline">Retry QR code</button>
        </div>
      )}
      {qr.data?.qrCodeDataUri && (
        <Image src={qr.data.qrCodeDataUri} alt={`Ticket QR Code ${ticket.id}`} width={180} height={180} unoptimized className="rounded bg-white p-2" />
      )}
      <p className="break-all font-mono text-xs text-gray-400">{ticket.id}</p>
    </div>
  );
}
