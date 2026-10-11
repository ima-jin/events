import { eq } from 'drizzle-orm';
import { db, events, orders, type Event, type NewOrder, type Order } from '@/db';

/** Order by id, or null when it does not exist. */
export async function findOrderById(orderId: string): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return row ?? null;
}

/** Insert an order row and return it as stored. */
export async function insertOrder(values: NewOrder): Promise<Order> {
  const [row] = await db.insert(orders).values(values).returning();
  return row;
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
