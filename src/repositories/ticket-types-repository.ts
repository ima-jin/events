import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, ticketTypes, type TicketType } from '@/db';

export type TicketTypeRow = typeof ticketTypes.$inferSelect;
export type NewTicketType = typeof ticketTypes.$inferInsert;

/** Tiers an event shows to everyone: those without an access code, in display order. */
export function listPublicTicketTypes(eventId: string): Promise<TicketTypeRow[]> {
  return db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.eventId, eventId), isNull(ticketTypes.accessCode)))
    .orderBy(asc(ticketTypes.sortOrder));
}

/** Tiers whose access code matches `code`, case-insensitively, in display order. */
export function listTicketTypesByAccessCode(eventId: string, code: string): Promise<TicketTypeRow[]> {
  return db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.eventId, eventId), sql`LOWER(${ticketTypes.accessCode}) = LOWER(${code})`))
    .orderBy(asc(ticketTypes.sortOrder));
}

/** The currency of every tier of the event (one entry per tier, hidden tiers included). */
export async function listTicketTypeCurrencies(eventId: string): Promise<string[]> {
  const rows = await db
    .select({ currency: ticketTypes.currency })
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId));
  return rows.map((row) => row.currency);
}

/** One tier of an event, or null when the id does not belong to that event. */
export async function getTicketTypeForEvent(tierId: string, eventId: string): Promise<TicketTypeRow | null> {
  const [row] = await db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.id, tierId), eq(ticketTypes.eventId, eventId)))
    .limit(1);
  return row ?? null;
}

export async function insertTicketType(values: NewTicketType): Promise<TicketTypeRow> {
  const [row] = await db.insert(ticketTypes).values(values).returning();
  return row;
}

export async function updateTicketType(tierId: string, updates: Record<string, unknown>): Promise<TicketTypeRow> {
  const [row] = await db.update(ticketTypes).set(updates).where(eq(ticketTypes.id, tierId)).returning();
  return row;
}

/** All ticket types of an event. */
export function findTicketTypesByEvent(eventId: string): Promise<TicketType[]> {
  return db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId));
}

/** Ticket types by id. */
export function findTicketTypesByIds(ticketTypeIds: string[]): Promise<TicketType[]> {
  return db.select().from(ticketTypes).where(inArray(ticketTypes.id, ticketTypeIds));
}

/** Add `count` to a ticket type's sold counter. */
export async function incrementSold(ticketTypeId: string, count: number): Promise<void> {
  await db
    .update(ticketTypes)
    .set({ sold: sql`${ticketTypes.sold} + ${count}` })
    .where(eq(ticketTypes.id, ticketTypeId));
}

/** Subtract `count` from a ticket type's sold counter, never below zero. */
export async function decrementSold(ticketTypeId: string, count: number): Promise<void> {
  await db
    .update(ticketTypes)
    .set({ sold: sql`GREATEST(${ticketTypes.sold} - ${count}, 0)` })
    .where(eq(ticketTypes.id, ticketTypeId));
}
