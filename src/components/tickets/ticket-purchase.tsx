'use client';

import { useState } from 'react';
import { effectiveMax, mergeTiers, type PublicTier } from '@/lib/public-event';
import { BuyerForm } from './buyer-form';
import { CheckoutPanel } from './checkout-panel';
import {
  reserveEtransfer,
  rsvpFree,
  startBalanceCheckout,
  startCardCheckout,
  type BuyerDetails,
  type CheckoutError,
  type CheckoutResult,
} from './checkout-api';
import { resolveRails, useBalanceCents, useCart, useCheckout } from './hooks';
import { ResultView } from './result-view';
import { ERROR_TEXT, MUTED } from './styles';
import { TierRow } from './tier-row';
import { UnlockForm } from './unlock-form';

export interface TicketPurchaseProps {
  eventId: string;
  tiers: PublicTier[];
  /** The event has access-code tiers that are not in `tiers`. */
  hasHiddenTiers: boolean;
  /** Invite token from the page URL, forwarded to every checkout call. */
  invite?: string;
  etransferEnabled: boolean;
  isAuthenticated: boolean;
  /** Event-wide cap on tickets per order (tiers may override it). */
  maxTicketsPerOrder: number | null;
}

type FormMode = { kind: 'etransfer' } | { kind: 'rsvp'; tier: PublicTier } | null;

/** The kernel answers 400 "...provide an email address..." when it can't resolve the buyer's email. */
function wantsEmail(failure: CheckoutError | null): boolean {
  return failure !== null && failure.status === 400 && /email/i.test(failure.message);
}

interface FormStepProps {
  form: NonNullable<FormMode>;
  busy: boolean;
  error: string | null;
  collectDetails: boolean;
  onSubmit: (buyer: BuyerDetails) => void;
  onCancel: () => void;
}

/** Confirm step for a free RSVP or an e-Transfer reservation. */
function FormStep({ form, ...rest }: Readonly<FormStepProps>) {
  if (form.kind === 'rsvp') {
    return (
      <BuyerForm {...rest} title={`RSVP — ${form.tier.name}`} submitLabel="Confirm RSVP" busyLabel="Confirming…">
        Confirm your RSVP to reserve your free spot.
      </BuyerForm>
    );
  }
  return (
    <BuyerForm {...rest} title="Pay by Interac e-Transfer" submitLabel="Reserve My Tickets" busyLabel="Reserving…">
      Your tickets are held for 72 hours while you send one Interac e-Transfer for the full amount.
    </BuyerForm>
  );
}

export function TicketPurchase(props: Readonly<TicketPurchaseProps>) {
  const { eventId, hasHiddenTiers, invite, etransferEnabled, isAuthenticated, maxTicketsPerOrder } = props;
  const [unlocked, setUnlocked] = useState<PublicTier[]>([]);
  const [form, setForm] = useState<FormMode>(null);
  const [needsDetails, setNeedsDetails] = useState(false);
  const tiers = mergeTiers(props.tiers, unlocked);
  const cart = useCart(tiers, maxTicketsPerOrder);
  const { state, run } = useCheckout();
  const balanceCents = useBalanceCents(isAuthenticated);

  const busy = state.status === 'busy';
  const collectDetails = !isAuthenticated || needsDetails;
  const rails = resolveRails({ etransferEnabled, noCardRail: state.noCardRail, balanceCents, totalCents: cart.totalCents });

  const attempt = async (task: () => Promise<CheckoutResult>) => {
    const failure = await run(task);
    if (wantsEmail(failure)) setNeedsDetails(true);
    return failure;
  };

  const startRsvp = async (tier: PublicTier) => {
    if (collectDetails) {
      setForm({ kind: 'rsvp', tier });
      return;
    }
    const failure = await attempt(() => rsvpFree(eventId, tier.id, {}, invite));
    if (wantsEmail(failure)) setForm({ kind: 'rsvp', tier });
  };

  const submitForm = (buyer: BuyerDetails) => {
    if (form?.kind === 'rsvp') return attempt(() => rsvpFree(eventId, form.tier.id, buyer, invite));
    return attempt(() => reserveEtransfer(eventId, cart.lines, buyer, invite));
  };

  if (state.status === 'done' && state.result) return <ResultView result={state.result} />;

  if (form) {
    return (
      <FormStep
        form={form}
        busy={busy}
        error={state.error}
        collectDetails={collectDetails}
        onSubmit={submitForm}
        onCancel={() => setForm(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {tiers.length === 0 && <p className={MUTED}>No tickets are available yet.</p>}
      <ul className="space-y-3">
        {tiers.map((tier) => (
          <TierRow
            key={tier.id}
            tier={tier}
            quantity={cart.quantities[tier.id] ?? 0}
            max={effectiveMax(tier, maxTicketsPerOrder)}
            busy={busy}
            onQuantityChange={(quantity) => cart.setQuantity(tier, quantity)}
            onRsvp={() => startRsvp(tier)}
          />
        ))}
      </ul>
      {state.error && <p role="alert" className={ERROR_TEXT}>{state.error}</p>}
      {cart.lines.length > 0 && (
        <CheckoutPanel
          totalCents={cart.totalCents}
          currency={cart.currency}
          rails={rails}
          noCardRail={state.noCardRail}
          balanceCents={balanceCents}
          busy={busy}
          onCard={() => attempt(() => startCardCheckout(eventId, cart.lines, invite))}
          onBalance={() => attempt(() => startBalanceCheckout(eventId, cart.lines, invite))}
          onEtransfer={() => setForm({ kind: 'etransfer' })}
        />
      )}
      {hasHiddenTiers && <UnlockForm eventId={eventId} onUnlocked={(found) => setUnlocked((prev) => mergeTiers(prev, found))} />}
    </div>
  );
}
