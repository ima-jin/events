'use client';

import { formatCents, isFreeTier, isSoldOut, type PublicTier } from '@/lib/public-event';
import { QuantityStepper } from './quantity-stepper';
import { BUTTON_PRIMARY_INLINE, MUTED } from './styles';

/** Show a scarcity hint once this few tickets remain. */
const LOW_STOCK_THRESHOLD = 10;

interface TierRowProps {
  tier: PublicTier;
  quantity: number;
  /** Most tickets of this tier one order may hold. */
  max: number;
  busy: boolean;
  onQuantityChange: (quantity: number) => void;
  onRsvp: () => void;
}

function TierAction({ tier, quantity, max, busy, onQuantityChange, onRsvp }: Readonly<TierRowProps>) {
  if (isSoldOut(tier)) {
    return (
      <button type="button" disabled className="cursor-not-allowed rounded-lg bg-gray-700 px-6 py-2.5 font-semibold text-gray-400">
        Sold Out
      </button>
    );
  }
  if (isFreeTier(tier)) {
    return (
      <button type="button" className={`${BUTTON_PRIMARY_INLINE} px-6`} disabled={busy} onClick={onRsvp} aria-label={`RSVP for ${tier.name}`}>
        RSVP
      </button>
    );
  }
  return <QuantityStepper label={tier.name} quantity={quantity} max={max} onChange={onQuantityChange} />;
}

function Availability({ tier }: Readonly<{ tier: PublicTier }>) {
  if (tier.available === null || tier.available <= 0 || tier.available > LOW_STOCK_THRESHOLD) return null;
  return <p className="text-xs text-orange-400">Only {tier.available} left</p>;
}

export function TierRow(props: Readonly<TierRowProps>) {
  const { tier, quantity } = props;
  const price = isFreeTier(tier) ? 'Free' : formatCents(tier.price, tier.currency);

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-gray-700 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h3 className="text-lg font-semibold">{tier.name}</h3>
        <p className="font-medium text-orange-500">{price}</p>
        {tier.description && <p className={MUTED}>{tier.description}</p>}
        {tier.perks.length > 0 && (
          <ul className="list-inside list-disc text-sm text-gray-400">
            {tier.perks.map((perk) => (
              <li key={perk}>{perk}</li>
            ))}
          </ul>
        )}
        <Availability tier={tier} />
        {quantity > 0 && <p className={MUTED}>{formatCents(tier.price * quantity, tier.currency)} for {quantity}</p>}
      </div>
      <TierAction {...props} />
    </li>
  );
}
