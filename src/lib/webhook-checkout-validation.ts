import { buildStripeCheckoutItems, totalStripeCheckoutItems } from '@/lib/checkout-helpers';
import type { CartEntry } from '@/lib/webhook-payment-helpers';

interface PaymentEvidence {
  rail?: string;
  sellerDid?: string;
  amountTotal: number;
  currency: string;
}

interface PricedTicketType {
  name: string;
  price: number;
  currency: string;
}

/** Compare only kernel-attested payment fields with this event's DB-priced cart. */
export function checkoutPaymentMismatch(
  payload: PaymentEvidence,
  event: { title: string; creatorDid: string; currency: string },
  cart: CartEntry[],
  typesById: Map<string, PricedTicketType>,
) {
  const expected = {
    rail: 'stripe-byo',
    sellerDid: event.creatorDid,
    currency: event.currency.toUpperCase(),
    amountTotal: null as number | null,
  };
  const got = {
    rail: payload.rail ?? null,
    sellerDid: payload.sellerDid ?? null,
    currency: payload.currency ?? null,
    amountTotal: payload.amountTotal ?? null,
  };

  const cartTypes = cart.map((item) => typesById.get(item.ticketTypeId));
  if (cartTypes.some((type) => !type)) {
    return { reason: 'unknown_ticket_type', expected, got };
  }
  expected.amountTotal = totalStripeCheckoutItems(buildStripeCheckoutItems(cart, typesById, event.title));
  if (cartTypes.some((type) => type!.currency.toUpperCase() !== expected.currency)) {
    return {
      reason: 'ticket_currency_mismatch', expected,
      got: { ...got, ticketCurrencies: cartTypes.map((type) => type!.currency) },
    };
  }
  if (payload.rail !== expected.rail || payload.sellerDid !== expected.sellerDid) {
    // No platform card rail exists under #2790. Metadata is never seller evidence.
    return { reason: 'seller_or_rail_mismatch', expected, got };
  }
  if (typeof payload.currency !== 'string' || payload.currency.toUpperCase() !== expected.currency) {
    return { reason: 'currency_mismatch', expected, got };
  }
  if (!Number.isSafeInteger(expected.amountTotal) || expected.amountTotal < 0
    || !Number.isSafeInteger(payload.amountTotal) || payload.amountTotal !== expected.amountTotal) {
    return { reason: 'amount_mismatch', expected, got };
  }
  return null;
}
