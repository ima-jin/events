import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, events, getClient, tickets } from '@/db';
import { holdingTicketStatuses } from '@/lib/ticket-holding';

/** Event statuses a creator / co-host still lists on their profile. */
const LISTED_EVENT_STATUSES = ['draft', 'published'];

/** Timestamp as postgres.js returns it: a Date, or an ISO string through raw SQL. */
export type DateLike = string | Date;

/** One ticket row of the organizer guest list (ticket + type + order columns). */
export interface GuestTicketRow {
  id: string;
  status: string;
  owner_did: string | null;
  price_paid: number | null;
  currency: string | null;
  purchased_at: DateLike | null;
  used_at: DateLike | null;
  payment_method: string | null;
  payment_id: string | null;
  hold_expires_at: DateLike | null;
  registration_status: string | null;
  last_email_sent_at: DateLike | null;
  ticket_type: string;
  registration_form_id: string | null;
  fair_settlement: unknown;
  amount_total: number | null;
  buyer_email: string | null;
  buyer_did: string | null;
}

/** One ticket row of the guest CSV export. */
export interface GuestExportRow {
  id: string;
  status: string;
  owner_did: string | null;
  purchased_at: DateLike | null;
  payment_method: string | null;
  ticket_payment_id: string | null;
  payment_confirmed_at: DateLike | null;
  registration_status: string | null;
  order_id: string | null;
  ticket_type: string;
  registration_form_id: string | null;
  order_payment_id: string | null;
  stripe_session_id: string | null;
  buyer_email: string | null;
  buyer_did: string | null;
}

/** An event as listed on a profile's "attending" list. */
export interface AttendingEventRow {
  eventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  venue: string | null;
  accessMode: string;
  imageUrl: string | null;
}

interface PodEventRecord {
  event_id: string;
  title: string;
  starts_at: DateLike;
  ends_at: DateLike | null;
  venue: string | null;
  access_mode: string;
  image_url: string | null;
}

const attendingColumns = {
  eventId: events.id,
  title: events.title,
  startsAt: events.startsAt,
  endsAt: events.endsAt,
  venue: events.venue,
  accessMode: events.accessMode,
  imageUrl: events.imageUrl,
};

/** Every ticket of an event with its type and order columns, newest first. */
export function listGuestTicketRows(eventId: string): Promise<GuestTicketRow[]> {
  const sql = getClient();
  return sql<GuestTicketRow[]>`
    SELECT t.id, t.status, t.owner_did, t.price_paid, t.currency, t.purchased_at, t.used_at,
           t.payment_method, t.payment_id, t.hold_expires_at, t.registration_status,
           t.last_email_sent_at,
           tt.name as ticket_type,
           tt.registration_form_id,
           o.fair_settlement, o.amount_total,
           o.buyer_email,
           o.buyer_did
    FROM events.tickets t
    JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
    LEFT JOIN events.orders o ON t.order_id = o.id
    WHERE t.event_id = ${eventId}
    ORDER BY t.created_at DESC
  `;
}

/** The id/title of an event, or null when it does not exist. */
export async function getEventTitle(eventId: string): Promise<{ id: string; title: string | null } | null> {
  const sql = getClient();
  const [event] = await sql<{ id: string; title: string | null }[]>`
    SELECT id, title FROM events.events WHERE id = ${eventId} LIMIT 1
  `;
  return event ?? null;
}

/** Ticket rows for the CSV export; cancelled/refunded tickets only when asked for. */
export function listGuestExportRows(eventId: string, includeCancelled: boolean): Promise<GuestExportRow[]> {
  const sql = getClient();
  const statusFilter = includeCancelled ? sql`` : sql`AND t.status NOT IN ('cancelled', 'refunded')`;
  return sql<GuestExportRow[]>`
    SELECT
      t.id,
      t.status,
      t.owner_did,
      t.purchased_at,
      t.payment_method,
      t.payment_id AS ticket_payment_id,
      t.payment_confirmed_at,
      t.registration_status,
      t.order_id,
      tt.name AS ticket_type,
      tt.registration_form_id,
      o.payment_id AS order_payment_id,
      o.stripe_session_id,
      o.buyer_email,
      o.buyer_did
    FROM events.tickets t
    JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
    LEFT JOIN events.orders o ON t.order_id = o.id
    WHERE t.event_id = ${eventId}
    ${statusFilter}
    ORDER BY t.created_at DESC
  `;
}

/** Upcoming events `ownerDid` holds a sold/used ticket for. */
export function listTicketedEvents(ownerDid: string, now: Date): Promise<AttendingEventRow[]> {
  return db
    .select(attendingColumns)
    .from(tickets)
    .innerJoin(events, eq(tickets.eventId, events.id))
    .where(and(eq(tickets.ownerDid, ownerDid), inArray(tickets.status, holdingTicketStatuses()), gt(events.startsAt, now)));
}

/** Upcoming draft/published events created by `ownerDid`. */
export function listCreatedEvents(ownerDid: string, now: Date): Promise<AttendingEventRow[]> {
  return db
    .select(attendingColumns)
    .from(events)
    .where(
      and(eq(events.creatorDid, ownerDid), inArray(events.status, LISTED_EVENT_STATUSES), gt(events.startsAt, now)),
    );
}

/** Upcoming draft/published events belonging to any of the given kernel pods. */
export async function listPodEvents(podIds: string[], now: Date): Promise<AttendingEventRow[]> {
  const sql = getClient();
  const rows = await sql<PodEventRecord[]>`
    SELECT e.id as event_id, e.title, e.starts_at, e.ends_at, e.venue, e.access_mode, e.image_url
    FROM events.events e
    WHERE e.pod_id = ANY(${podIds})
      AND e.status IN ('draft', 'published')
      AND e.starts_at > ${now.toISOString()}
  `;
  return rows.map((r) => ({
    eventId: r.event_id,
    title: r.title,
    startsAt: new Date(r.starts_at),
    endsAt: r.ends_at ? new Date(r.ends_at) : null,
    venue: r.venue,
    accessMode: r.access_mode,
    imageUrl: r.image_url ?? null,
  }));
}

/** Which of `eventIds` the viewer holds a sold/used ticket for. */
export async function listHeldEventIds(viewerDid: string, eventIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ eventId: tickets.eventId })
    .from(tickets)
    .where(
      and(eq(tickets.ownerDid, viewerDid), inArray(tickets.status, holdingTicketStatuses()), inArray(tickets.eventId, eventIds)),
    );
  return rows.map((r) => r.eventId);
}
