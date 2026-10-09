'use client';

import { useCallback, useEffect, useState } from 'react';
import { effectiveMax, isFreeTier, type PublicTier } from '@/lib/public-event';
import { CheckoutError, fetchBalanceCents, isNoCardRail, type CartLine, type CheckoutResult, type FinishedCheckout } from './checkout-api';

// ---------------------------------------------------------------------------
// Checkout state machine
// ---------------------------------------------------------------------------

export interface CheckoutState {
  status: 'idle' | 'busy' | 'done';
  result: FinishedCheckout | null;
  error: string | null;
  /** Set once `POST /api/checkout` answered 409 SELLER_NO_CARD_RAIL: the card rail is gone for this event. */
  noCardRail: boolean;
}

const IDLE: CheckoutState = { status: 'idle', result: null, error: null, noCardRail: false };

/** The error to surface to the buyer (never a raw non-Error value). */
function toCheckoutError(error: unknown): CheckoutError {
  if (error instanceof CheckoutError) return error;
  return new CheckoutError(error instanceof Error ? error.message : 'Something went wrong', 0);
}

/**
 * Runs one checkout attempt at a time. Resolves with the failure (or `null` on
 * success) so a caller can branch on it, e.g. to ask for an email address.
 */
export function useCheckout() {
  const [state, setState] = useState<CheckoutState>(IDLE);

  const run = useCallback(async (task: () => Promise<CheckoutResult>): Promise<CheckoutError | null> => {
    setState((prev) => ({ ...prev, status: 'busy', error: null }));
    try {
      const result = await task();
      if (result.kind === 'redirect') {
        // Keep the busy state: the browser is navigating to the card provider.
        globalThis.location.assign(result.url);
        return null;
      }
      setState((prev) => ({ ...prev, status: 'done', result }));
      return null;
    } catch (error) {
      const failure = toCheckoutError(error);
      const cardGone = isNoCardRail(failure);
      setState((prev) => ({
        ...prev,
        status: 'idle',
        // The "card payment isn't set up" notice replaces the raw server message.
        error: cardGone ? null : failure.message,
        noCardRail: prev.noCardRail || cardGone,
      }));
      return failure;
    }
  }, []);

  return { state, run };
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export interface Cart {
  quantities: Record<string, number>;
  lines: CartLine[];
  totalCents: number;
  currency: string;
  setQuantity: (tier: PublicTier, quantity: number) => void;
}

/** Quantities for the paid tiers (free tiers RSVP individually and never enter the cart). */
export function useCart(tiers: PublicTier[], eventMax: number | null): Cart {
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const setQuantity = useCallback(
    (tier: PublicTier, quantity: number) => {
      const bounded = Math.max(0, Math.min(quantity, effectiveMax(tier, eventMax)));
      setQuantities((prev) => ({ ...prev, [tier.id]: bounded }));
    },
    [eventMax],
  );

  const picked = tiers.filter((tier) => !isFreeTier(tier) && (quantities[tier.id] ?? 0) > 0);
  const lines = picked.map((tier) => ({ ticketTypeId: tier.id, quantity: quantities[tier.id] }));
  const totalCents = picked.reduce((sum, tier) => sum + tier.price * quantities[tier.id], 0);
  return { quantities, lines, totalCents, currency: picked[0]?.currency ?? tiers[0]?.currency ?? 'CAD', setQuantity };
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/** The signed-in buyer's MJNx balance in cents (`null` while loading, signed out, or unavailable). */
export function useBalanceCents(enabled: boolean): number | null {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetchBalanceCents().then((cents) => {
      if (!cancelled) setBalance(cents);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return balance;
}

// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------

export interface RailAvailability {
  card: boolean;
  balance: boolean;
  etransfer: boolean;
}

interface RailInputs {
  etransferEnabled: boolean;
  noCardRail: boolean;
  balanceCents: number | null;
  totalCents: number;
}

/** Which payment rails to offer: the card rail is hidden once the organizer is known to have none. */
export function resolveRails({ etransferEnabled, noCardRail, balanceCents, totalCents }: RailInputs): RailAvailability {
  return {
    card: !noCardRail,
    balance: balanceCents !== null && balanceCents >= totalCents,
    etransfer: etransferEnabled,
  };
}
