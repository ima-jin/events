import { and, asc, desc, eq, gt, type SQL } from 'drizzle-orm';
import { db, events, ticketTypes } from '@/db';

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type TicketTypeRow = typeof ticketTypes.$inferSelect;
export type NewTicketTypeRow = typeof ticketTypes.$inferInsert;

/** Columns the by-DID lookup exposes (used by the chat service to resolve event names). */
export interface EventSummary {
  id: string;
  title: string;
  did: string | null;
}

export interface EventListFilter {
  status: string;
  courseSlug?: string | null;
  /** Only events starting in the future, soonest first (otherwise newest first). */
  upcoming?: boolean;
  limit: number;
}

/** Who owns an event: its creator and the kernel pod that holds its co-hosts. */
export async function getEventOwnership(eventId: string): Promise<{ creatorDid: string; podId: string | null } | null> {
  const [row] = await db
    .select({ creatorDid: events.creatorDid, podId: events.podId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row ?? null;
}

/** The full event row, or null when the event does not exist. */
export async function getEventById(eventId: string): Promise<EventRow | null> {
  const [row] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return row ?? null;
}

/** id / title / did of the event with the given DID, or null. */
export async function getEventSummaryByDid(did: string): Promise<EventSummary | null> {
  const [row] = await db
    .select({ id: events.id, title: events.title, did: events.did })
    .from(events)
    .where(eq(events.did, did))
    .limit(1);
  return row ?? null;
}

/** Events matching the filter. */
export function listEvents(filter: EventListFilter): Promise<EventRow[]> {
  const conditions: SQL[] = [eq(events.status, filter.status)];
  if (filter.courseSlug) conditions.push(eq(events.courseSlug, filter.courseSlug));
  if (filter.upcoming) conditions.push(gt(events.startsAt, new Date()));

  return db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(filter.upcoming ? asc(events.startsAt) : desc(events.startsAt))
    .limit(filter.limit);
}

/** Every event created by `creatorDid`, newest first. */
export function listEventsByCreator(creatorDid: string): Promise<EventRow[]> {
  return db.select().from(events).where(eq(events.creatorDid, creatorDid)).orderBy(desc(events.createdAt));
}

/** Insert an event and return the stored row. */
export async function insertEvent(values: NewEventRow): Promise<EventRow> {
  const [row] = await db.insert(events).values(values).returning();
  return row;
}

/** Apply a partial update to an event and return the stored row (undefined when no row matched). */
export async function updateEventById(eventId: string, updates: Partial<NewEventRow>): Promise<EventRow | undefined> {
  const [row] = await db.update(events).set(updates).where(eq(events.id, eventId)).returning();
  return row;
}

/** All ticket types of an event. */
export function listTicketTypesForEvent(eventId: string): Promise<TicketTypeRow[]> {
  return db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId));
}

/** Insert ticket types and return the stored rows. */
export function insertTicketTypes(values: NewTicketTypeRow[]): Promise<TicketTypeRow[]> {
  return db.insert(ticketTypes).values(values).returning();
}
