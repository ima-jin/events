import { and, eq, sql } from 'drizzle-orm';
import { db, events, orders, tickets, ticketTypes, type Event, type NewOrder, type Order } from '@/db';
import type { TicketInsert } from '@/repositories/tickets-repository';
import { withHostedOrderExpiry } from '@/lib/hosted-order-expiry';

/** Order by id, or null when it does not exist. */
export async function findOrderById(orderId: string): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return row ? withHostedOrderExpiry(row) : null;
}

/** Insert an order row and return it as stored. */
export async function insertOrder(values: NewOrder): Promise<Order> {
  const [row] = await db.insert(orders).values(values).returning();
  return row;
}

/** No completed state is visible unless tickets and sold counts also commit. */
export function completeHostedOrder(
  orderId: string,
  values: NewOrder,
  ticketValues: TicketInsert[],
  soldCounts: Array<{ ticketTypeId: string; quantity: number }>,
): Promise<{ order: Order; tickets: typeof tickets.$inferSelect[] }> {
  return db.transaction(async (tx) => {
    const [order] = await tx.update(orders).set(values).where(and(
      eq(orders.id, orderId),
      eq(orders.status, 'pending'),
    )).returning();
    if (!order) throw new Error('Hosted checkout order is no longer pending');
    const createdTickets = await tx.insert(tickets).values(ticketValues).returning();
    await Promise.all(soldCounts.map((item) =>
      tx.update(ticketTypes).set({
        sold: sql`${ticketTypes.sold} + ${item.quantity}`,
      }).where(eq(ticketTypes.id, item.ticketTypeId)),
    ));
    return { order, tickets: createdTickets };
  });
}

/**
 * Claim one attempt before contacting the kernel. An unknown outcome must never
 * be retried automatically, including through organizer ticket resends.
 */
export async function claimOrderOnboard(orderId: string): Promise<string | null> {
  const [row] = await db.update(orders).set({
    metadata: sql`jsonb_set(${orders.metadata}, '{onboardRequestedAt}', to_jsonb(${new Date().toISOString()}::text))`,
  }).where(and(
    eq(orders.id, orderId),
    eq(orders.status, 'completed'),
    eq(orders.paymentMethod, 'stripe'),
    sql`${orders.stripeSessionId} IS NOT NULL`,
    sql`length(btrim(${orders.stripeSessionId})) > 0`,
    sql`jsonb_typeof(${orders.metadata}->'kernelTransactionId') = 'string'`,
    sql`length(btrim(${orders.metadata}->>'kernelTransactionId')) > 0`,
    sql`NOT (${orders.metadata} ? 'onboardRequestedAt')`,
  )).returning({ metadata: orders.metadata });
  const metadata = row?.metadata as { kernelTransactionId?: string } | undefined;
  return metadata?.kernelTransactionId ?? null;
}

/** Flip an order to `completed` (payment confirmed) at `purchasedAt`. */
export async function markOrderCompleted(orderId: string, purchasedAt: Date): Promise<void> {
  await db.update(orders).set({ status: 'completed', purchasedAt }).where(eq(orders.id, orderId));
}

/** Flip an order to `refunded`. */
export async function markOrderRefunded(orderId: string): Promise<void> {
  await db.update(orders).set({ status: 'refunded' }).where(eq(orders.id, orderId));
}

/** Event by id, or null — the order/ticket flows only need the row for notifications and 404s. */
export async function findEventById(eventId: string): Promise<Event | null> {
  const [row] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return row ?? null;
}
