'use client';

import { formatCents } from '@/lib/public-event';
import type { RailAvailability } from './hooks';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, MUTED } from './styles';

interface CheckoutPanelProps {
  totalCents: number;
  currency: string;
  rails: RailAvailability;
  noCardRail: boolean;
  balanceCents: number | null;
  busy: boolean;
  onCard: () => void;
  onBalance: () => void;
  onEtransfer: () => void;
}

function RailButtons({ rails, balanceCents, currency, busy, onCard, onBalance, onEtransfer }: Readonly<CheckoutPanelProps>) {
  return (
    <div className="flex flex-col gap-2">
      {rails.card && (
        <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={onCard}>
          {busy ? 'Loading…' : 'Pay with Card'}
        </button>
      )}
      {rails.balance && balanceCents !== null && (
        <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={onBalance}>
          Pay with Balance — {formatCents(balanceCents, currency)}
        </button>
      )}
      {rails.etransfer && (
        <div className="space-y-1">
          <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={onEtransfer}>
            Pay by e-Transfer
          </button>
          <p className="text-xs text-gray-500">
            e-Transfer payments go directly to the event organizer. Refunds are handled between you and the organizer.
          </p>
        </div>
      )}
    </div>
  );
}

/** Order total and the payment rails available for it. Renders nothing until something is in the cart. */
export function CheckoutPanel(props: Readonly<CheckoutPanelProps>) {
  const { totalCents, currency, rails, noCardRail } = props;
  const hasRail = rails.card || rails.balance || rails.etransfer;

  return (
    <section aria-label="Checkout" className="space-y-3 border-t border-gray-700 pt-4">
      <p className="flex justify-between font-semibold">
        <span>Total</span>
        <span>{formatCents(totalCents, currency)}</span>
      </p>
      {noCardRail && (
        <p role="status" className={MUTED}>
          Card payment isn&apos;t set up for this event.
        </p>
      )}
      {hasRail ? (
        <RailButtons {...props} />
      ) : (
        <p className={MUTED}>No payment method is available for this event right now.</p>
      )}
    </section>
  );
}
