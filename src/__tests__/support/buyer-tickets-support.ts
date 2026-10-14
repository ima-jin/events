import type { BuyerTicketRow } from '@/repositories/buyer-tickets-repository';
import type { FairSettlement } from '@/lib/buyer-tickets';
import { makeTicket, OWNER_DID } from './ticket-access-support';

export const PURCHASED_AT = '2030-01-01T00:00:00.000Z';
export const ORDER_ID = 'ord_1';

export function fairReceipt(overrides: Record<string, unknown> = {}): FairSettlement {
  return {
    version: '1.1',
    settledAt: PURCHASED_AT,
    totalAmount: 25,
    netAmount: 24,
    currency: 'CAD',
    fees: [{ role: 'processing', name: 'Card processing', rateBps: 290, fixedCents: 30, amount: 1, estimated: true }],
    chain: [{ did: 'did:imajin:seller', role: 'seller', amount: 24 }],
    ...overrides,
  };
}

/** Composes the existing ticket fixture instead of duplicating it. */
export function buyerRow(
  ticket: Partial<BuyerTicketRow['ticket']> = {},
  ticketType: Partial<NonNullable<BuyerTicketRow['ticketType']>> | null = {},
  order: Partial<NonNullable<BuyerTicketRow['order']>> | null = {},
): BuyerTicketRow {
  return {
    ticket: {
      ...makeTicket(),
      orderId: ORDER_ID,
      usedAt: null,
      purchasedAt: new Date(PURCHASED_AT),
      createdAt: null,
      legacyFairSettlement: null,
      ...ticket,
    } as BuyerTicketRow['ticket'],
    ticketType: ticketType ? {
      id: 'tt_1', name: 'VIP', description: 'Front row', perks: ['drink'], registrationFormId: 'form_1',
      ...ticketType,
    } : null,
    order: order ? {
      id: ORDER_ID, buyerDid: OWNER_DID, quantity: 1, amountTotal: 2500, currency: 'CAD', fairSettlement: null,
      ...order,
    } : null,
  };
}
