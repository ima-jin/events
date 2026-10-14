import { and, eq, sql } from 'drizzle-orm';
import { db, events, orders, tickets, ticketTypes } from '@/db';

/** Only the columns needed for a buyer projection; no payment ids or email. */
export function listOwnedTicketRows(eventId: string, ownerDid: string) {
  return db
    .select({
      ticket: {
        id: tickets.id,
        orderId: tickets.orderId,
        status: tickets.status,
        usedAt: tickets.usedAt,
        registrationStatus: tickets.registrationStatus,
        purchasedAt: tickets.purchasedAt,
        createdAt: tickets.createdAt,
        pricePaid: tickets.pricePaid,
        currency: tickets.currency,
        legacyFairSettlement: sql<unknown>`${tickets.metadata} -> 'fair_settlement'`,
      },
      ticketType: {
        id: ticketTypes.id,
        name: ticketTypes.name,
        description: ticketTypes.description,
        perks: ticketTypes.perks,
        registrationFormId: ticketTypes.registrationFormId,
      },
      order: {
        id: orders.id,
        buyerDid: orders.buyerDid,
        quantity: orders.quantity,
        amountTotal: orders.amountTotal,
        currency: orders.currency,
        fairSettlement: orders.fairSettlement,
      },
    })
    .from(tickets)
    .leftJoin(ticketTypes, and(eq(tickets.ticketTypeId, ticketTypes.id), eq(ticketTypes.eventId, eventId)))
    .leftJoin(orders, and(eq(tickets.orderId, orders.id), eq(orders.eventId, eventId)))
    .where(and(eq(tickets.eventId, eventId), eq(tickets.ownerDid, ownerDid)));
}

export type BuyerTicketRow = Awaited<ReturnType<typeof listOwnedTicketRows>>[number];

/** Preserve the access route's creator / host / cohost / owner check. */
export async function getBuyerEventAccess(eventId: string) {
  const [event] = await db
    .select({ creatorDid: events.creatorDid, podId: events.podId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return event ?? null;
}
