import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, ticketTypes } from '@/db';

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
