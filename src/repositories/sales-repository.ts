import { getClient } from '@/db';
import type { DateLike } from '@/repositories/guests-repository';

/** postgres.js returns COUNT/SUM aggregates as strings (bigint/numeric), plain ints as numbers. */
export type NumericLike = number | string;

/** The event columns the sales reports need (filename + currency fallback). */
export interface SalesEventRow {
  id: string;
  title: string | null;
  currency: string | null;
}

/** One order x ticket row of the sales report (an order with no tickets yet has null ticket columns). */
export interface OrderSaleRow {
  order_id: string;
  buyer_did: string | null;
  amount_total: number | null;
  currency: string | null;
  payment_method: string | null;
  stripe_session_id: string | null;
  purchased_at: DateLike | null;
  created_at: DateLike;
  ticket_id: string | null;
  ticket_status: string | null;
  ticket_type_name: string | null;
  registration_form_id: string | null;
}

/** A ticket with no order (it predates the orders system). */
export interface OrphanTicketRow {
  ticket_id: string;
  status: string | null;
  owner_did: string | null;
  price_paid: number | null;
  currency: string | null;
  purchased_at: DateLike | null;
  payment_method: string | null;
  payment_id: string | null;
  ticket_type_name: string | null;
  registration_form_id: string | null;
}

/** One order row of the sales CSV export. */
export interface ExportOrderRow {
  order_id: string;
  buyer_did: string | null;
  quantity: number;
  amount_total: number;
  currency: string | null;
  payment_method: string | null;
  stripe_session_id: string | null;
  payment_id: string | null;
  purchased_at: DateLike | null;
  ticket_type: string;
}

export interface TicketStatusRow {
  id: string;
  status: string;
  order_id: string | null;
}

/** One event of the platform-admin overview export. */
export interface AdminEventRow {
  id: string;
  title: string;
  status: string;
  starts_at: DateLike | null;
  ends_at: DateLike | null;
  city: string | null;
  creator_did: string | null;
  ticket_type_count: NumericLike;
  tickets_sold: NumericLike;
  tickets_used: NumericLike;
  total_revenue: NumericLike;
  currency: string | null;
  has_registration_form: boolean;
  surveys_completed: NumericLike;
}

/** The id/title/currency of an event, or null when it does not exist. */
export async function getSalesEvent(eventId: string): Promise<SalesEventRow | null> {
  const sql = getClient();
  const [event] = await sql<SalesEventRow[]>`
    SELECT id, title, currency FROM events.events WHERE id = ${eventId} LIMIT 1
  `;
  return event ?? null;
}

/** Every order of an event joined with its tickets and ticket types, newest order first. */
export function listOrderSaleRows(eventId: string): Promise<OrderSaleRow[]> {
  const sql = getClient();
  return sql<OrderSaleRow[]>`
    SELECT
      o.id AS order_id,
      o.buyer_did,
      o.amount_total,
      o.currency,
      o.payment_method,
      o.stripe_session_id,
      o.purchased_at,
      o.created_at,
      t.id AS ticket_id,
      t.status AS ticket_status,
      tt.name AS ticket_type_name,
      tt.registration_form_id
    FROM events.orders o
    LEFT JOIN events.tickets t ON t.order_id = o.id
    LEFT JOIN events.ticket_types tt ON tt.id = t.ticket_type_id
    WHERE o.event_id = ${eventId}
    ORDER BY o.created_at DESC, t.created_at ASC
  `;
}

/** Tickets of an event that have no order. */
export function listOrphanTicketRows(eventId: string): Promise<OrphanTicketRow[]> {
  const sql = getClient();
  return sql<OrphanTicketRow[]>`
    SELECT
      t.id AS ticket_id,
      t.status,
      t.owner_did,
      t.price_paid,
      t.currency,
      t.purchased_at,
      t.payment_method,
      t.payment_id,
      tt.name AS ticket_type_name,
      tt.registration_form_id
    FROM events.tickets t
    LEFT JOIN events.ticket_types tt ON tt.id = t.ticket_type_id
    WHERE t.event_id = ${eventId}
      AND t.order_id IS NULL
    ORDER BY t.purchased_at DESC NULLS LAST, t.created_at DESC
  `;
}

/** Orders of an event (with their ticket type) for the CSV export, most recently purchased first. */
export function listExportOrderRows(eventId: string): Promise<ExportOrderRow[]> {
  const sql = getClient();
  return sql<ExportOrderRow[]>`
    SELECT
      o.id as order_id,
      o.buyer_did,
      o.quantity,
      o.amount_total,
      o.currency,
      o.payment_method,
      o.stripe_session_id,
      o.payment_id,
      o.purchased_at,
      tt.name as ticket_type
    FROM events.orders o
    JOIN events.ticket_types tt ON o.ticket_type_id = tt.id
    WHERE o.event_id = ${eventId}
    ORDER BY o.purchased_at DESC NULLS LAST, o.created_at DESC
  `;
}

/** The id/status/order of every ticket of an event. */
export function listTicketStatusRows(eventId: string): Promise<TicketStatusRow[]> {
  const sql = getClient();
  return sql<TicketStatusRow[]>`
    SELECT id, status, order_id
    FROM events.tickets
    WHERE event_id = ${eventId}
  `;
}

/** Every event with its ticket/revenue/survey aggregates, newest first (platform admin). */
export function listAdminEventRows(): Promise<AdminEventRow[]> {
  const sql = getClient();
  return sql<AdminEventRow[]>`
    WITH ticket_stats AS (
      SELECT
        event_id,
        COUNT(*) FILTER (WHERE status IN ('valid', 'used', 'held')) AS sold,
        COUNT(*) FILTER (WHERE used_at IS NOT NULL) AS used,
        SUM(price_paid) FILTER (WHERE status NOT IN ('refunded', 'cancelled')) AS revenue,
        COUNT(*) FILTER (WHERE registration_status = 'complete') AS surveys_completed
      FROM events.tickets
      GROUP BY event_id
    ),
    currency_info AS (
      SELECT
        event_id,
        COUNT(DISTINCT currency) AS currency_count,
        MAX(currency) AS sample_currency
      FROM events.tickets
      WHERE currency IS NOT NULL
      GROUP BY event_id
    ),
    type_info AS (
      SELECT
        event_id,
        COUNT(*) AS type_count,
        BOOL_OR(registration_form_id IS NOT NULL) AS has_form
      FROM events.ticket_types
      GROUP BY event_id
    )
    SELECT
      e.id,
      e.title,
      e.status,
      e.starts_at,
      e.ends_at,
      e.city,
      e.creator_did,
      COALESCE(ti.type_count, 0) AS ticket_type_count,
      COALESCE(ts.sold, 0) AS tickets_sold,
      COALESCE(ts.used, 0) AS tickets_used,
      COALESCE(ts.revenue, 0) AS total_revenue,
      CASE WHEN ci.currency_count > 1 THEN '' ELSE ci.sample_currency END AS currency,
      COALESCE(ti.has_form, false) AS has_registration_form,
      COALESCE(ts.surveys_completed, 0) AS surveys_completed
    FROM events.events e
    LEFT JOIN ticket_stats ts ON ts.event_id = e.id
    LEFT JOIN currency_info ci ON ci.event_id = e.id
    LEFT JOIN type_info ti ON ti.event_id = e.id
    ORDER BY e.created_at DESC
  `;
}
