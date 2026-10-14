'use client';

import { useEffect, useState } from 'react';
import type { BuyerTicket } from '@/lib/buyer-tickets';
import { useRegistrationMessages, useTicketRegistration } from './registration-hooks';

function registrationUrl(base: string | null, formId: string | null | undefined, ticketId: string): string | null {
  if (!base || !formId) return null;
  let end = base.length;
  while (end > 0 && base[end - 1] === '/') end -= 1;
  return `${base.slice(0, end)}/embed/${encodeURIComponent(formId)}?ticketId=${encodeURIComponent(ticketId)}`;
}

export function TicketRegistration({
  ticket, embedBaseUrl, onComplete,
}: Readonly<{ ticket: BuyerTicket; embedBaseUrl: string | null; onComplete: () => void }>) {
  const pending = ticket.registrationStatus === 'pending';
  const [open, setOpen] = useState(pending);
  useEffect(() => setOpen(pending), [pending]);
  const registration = useTicketRegistration(ticket.id, onComplete);
  const url = registrationUrl(embedBaseUrl, ticket.ticketType?.registrationFormId, ticket.id);
  const { iframe, height } = useRegistrationMessages(url, registration.complete);
  const eligible = ticket.status === 'valid' || ticket.status === 'held' || ticket.status === 'used';
  if (ticket.registrationStatus === 'not_required' || !ticket.ticketType?.registrationFormId || !eligible) return null;

  return (
    <div className="mt-4 rounded-lg border border-gray-700 p-3" data-registration-pending={pending || undefined}>
      <button type="button" aria-expanded={open} aria-controls={`registration-${ticket.id}`}
        onClick={() => setOpen((value) => !value)} className="font-semibold text-orange-400">
        {pending ? 'Complete Registration' : 'Attendee details'} · {ticket.id}
      </button>
      {!pending && <p className="text-sm text-green-400">Registration complete</p>}
      {open && (
        <div id={`registration-${ticket.id}`} className="mt-3">
          {url ? (
            <iframe ref={iframe} src={url} title={`Attendee registration ${ticket.id}`}
              className="w-full rounded border-0 bg-white" style={{ height }} allow="clipboard-write" />
          ) : (
            <p role="alert">The registration form is unavailable. Please contact the event organizer.</p>
          )}
          {pending && url && (
            <button type="button" disabled={registration.busy} onClick={() => void registration.complete()}
              className="mt-3 rounded-lg bg-orange-500 px-4 py-2 font-semibold text-white disabled:opacity-50">
              {registration.busy ? 'Confirming registration…' : 'Check registration completion'}
            </button>
          )}
        </div>
      )}
      {registration.error && (
        <div role="alert" className="mt-2 text-red-400">
          <p>{registration.error}</p>
          <button type="button" disabled={registration.busy} onClick={() => void registration.complete()} className="underline">
            Retry registration
          </button>
        </div>
      )}
    </div>
  );
}
