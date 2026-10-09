import { and, eq, inArray, lt } from 'drizzle-orm';
import { db, getClient, tickets, type Ticket } from '@/db';

export type TicketInsert = typeof tickets.$inferInsert;

/** Raw-SQL projection (snake_case) of the ticket columns the refund flow reads. */
export interface RefundableTicket {
  id: string;
  status: string;
  price_paid: number | null;
  payment_id: string | null;
  payment_method: string | null;
  ticket_type_id: string | null;
  owner_did: string | null;
  currency: string | null;
}

/** Ticket status pair returned by the raw refund-state queries. */
export interface TicketStatusRow {
  id: string;
  status: string;
}

/** Ticket by id, or null. */
export async function findTicketById(ticketId: string): Promise<Ticket | null> {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return row ?? null;
}

/** Ticket by id scoped to an event, or null. */
export async function findTicketInEvent(eventId: string, ticketId: string): Promise<Ticket | null> {
  const [row] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
    .limit(1);
  return row ?? null;
}

/** Held e-Transfer tickets of an order (what an organizer confirms on payment). */
export async function findHeldEtransferTicketsByOrder(orderId: string): Promise<Ticket[]> {
  const rows = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.orderId, orderId),
        eq(tickets.status, 'held'),
        eq(tickets.paymentMethod, 'etransfer'),
      ),
    );
  return rows;
}

/** Tickets of an order that can still be refunded (`valid` or `used`). */
export async function findRefundableTicketsByOrder(orderId: string): Promise<Ticket[]> {
  const rows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orderId, orderId), inArray(tickets.status, ['valid', 'used'])));
  return rows;
}

/** Insert a ticket row and return it as stored. */
export async function insertTicket(values: TicketInsert): Promise<Ticket> {
  const [row] = await db.insert(tickets).values(values).returning();
  return row;
}

/** Turn still-held tickets valid and clear their hold; returns the rows that actually changed. */
export async function markHeldTicketsValid(ticketIds: string[], at: Date): Promise<Ticket[]> {
  const rows = await db
    .update(tickets)
    .set({
      status: 'valid',
      purchasedAt: at,
      paymentConfirmedAt: at,
      heldBy: null,
      heldUntil: null,
      holdExpiresAt: null,
    })
    .where(and(inArray(tickets.id, ticketIds), eq(tickets.status, 'held')))
    .returning();
  return rows;
}

/** Mark the given tickets `refunded`. */
export async function markTicketsRefunded(ticketIds: string[]): Promise<void> {
  await db.update(tickets).set({ status: 'refunded' }).where(inArray(tickets.id, ticketIds));
}

/** Cancel a ticket and drop its hold; returns the updated row. */
export async function cancelTicketRow(ticketId: string): Promise<Ticket> {
  const [row] = await db
    .update(tickets)
    .set({ status: 'cancelled', heldBy: null, heldUntil: null })
    .where(eq(tickets.id, ticketId))
    .returning();
  return row;
}

/** Return held tickets of a type whose hold has lapsed before `now` to the pool. */
export async function releaseExpiredHolds(ticketTypeId: string, now: Date): Promise<void> {
  await db
    .update(tickets)
    .set({ status: 'available', heldBy: null, heldUntil: null })
    .where(
      and(
        eq(tickets.ticketTypeId, ticketTypeId),
        eq(tickets.status, 'held'),
        lt(tickets.heldUntil, now),
      ),
    );
}

/** The ticket to refund, scoped to its event, or null. */
export async function loadRefundableTicket(
  eventId: string,
  ticketId: string,
): Promise<RefundableTicket | null> {
  const [ticket] = await getClient()`
    SELECT id, status, price_paid, payment_id, payment_method, ticket_type_id, owner_did, currency
    FROM events.tickets
    WHERE id = ${ticketId} AND event_id = ${eventId}
    LIMIT 1
  `;
  return (ticket as RefundableTicket | undefined) ?? null;
}

/** Set a ticket's refund status (`refunded` or `refund_pending`); returns `{ id, status }`. */
export async function setTicketRefundStatus(
  ticketId: string,
  status: 'refunded' | 'refund_pending',
): Promise<TicketStatusRow> {
  const [updated] = await getClient()`
    UPDATE events.tickets
    SET status = ${status}
    WHERE id = ${ticketId}
    RETURNING id, status
  `;
  return updated as TicketStatusRow;
}

/** `{ id, status }` of a ticket scoped to its event, or null. */
export async function findTicketStatus(
  eventId: string,
  ticketId: string,
): Promise<TicketStatusRow | null> {
  const [ticket] = await getClient()`
    SELECT id, status
    FROM events.tickets
    WHERE id = ${ticketId} AND event_id = ${eventId}
    LIMIT 1
  `;
  return (ticket as TicketStatusRow | undefined) ?? null;
}

/** Complete a pending e-Transfer refund: `refund_pending` -> `refunded`. */
export async function markRefundSentRow(ticketId: string): Promise<TicketStatusRow> {
  const [updated] = await getClient()`
    UPDATE events.tickets
    SET status = 'refunded'
    WHERE id = ${ticketId}
    RETURNING id, status
  `;
  return updated as TicketStatusRow;
}
