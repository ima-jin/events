import { csvRow } from '@/lib/guest-export-helpers';
import { resolveProfiles, type ResolvedProfile } from '@/lib/kernel';
import { getSurveyResponsesForTickets, type SurveyAnswers, type SurveyResponse } from '@/lib/surveys';
import type { DateLike } from '@/repositories/guests-repository';
import {
  getSalesEvent,
  listExportOrderRows,
  listOrderSaleRows,
  listOrphanTicketRows,
  listTicketStatusRows,
  type OrderSaleRow,
  type OrphanTicketRow,
  type SalesEventRow,
  type TicketStatusRow,
} from '@/repositories/sales-repository';
import { isEventOrganizer } from '@/services/authorization';
import { ServiceError } from '@/services/errors';

const FORBIDDEN_MESSAGE = 'Forbidden';
const UNKNOWN = 'unknown';
const UNKNOWN_LABEL = 'Unknown';
const CSV_BOM = '\uFEFF';
export const CSV_MIME = 'text/csv; charset=utf-8';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COMPLETED_TICKET_STATUSES = new Set(['valid', 'used']);
const SALES_HEADERS = [
  'Order ID',
  'Transaction ID',
  'Buyer Name',
  'Buyer Handle',
  'Buyer Email',
  'Buyer DID',
  'Ticket Type',
  'Quantity',
  'Amount',
  'Currency',
  'Status',
  'Payment Method',
  'Date',
  'Stripe Session ID',
];
const EXPORT_HEADERS = [
  'Order ID',
  'Buyer Name',
  'Buyer Handle',
  'Buyer Email',
  'Buyer DID',
  'Ticket Type',
  'Quantity',
  'Amount Total',
  'Currency',
  'Status',
  'Payment Method',
  'Stripe Session ID',
  'Stripe Payment ID',
  'Purchased At',
  'Ticket IDs',
  'Ticket Statuses',
];

type Identities = Map<string, ResolvedProfile>;

export interface CsvFile {
  filename: string;
  contentType: string;
  /** UTF-8 CSV text, prefixed with a BOM so spreadsheets detect the encoding. */
  content: string;
}

export interface SalesOptions {
  /** `csv` / `xlsx` select a download; anything else is the JSON report. */
  format?: string | null;
  callerCookie?: string | null;
}

export interface SaleTicket {
  id: string;
  type: string;
  attendeeName: string | null;
  status: string;
}

export interface Sale {
  transactionId: string | null;
  orderId: string;
  buyer: { did: string | null; name: string | null; handle: string | null; email: string | null };
  tickets: SaleTicket[];
  /** Major currency units. */
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string | null;
  stripeSessionId: string | null;
  createdAt: string;
}

/** One line of the unified sales list (an order, or an orphan ticket). */
export interface SaleView {
  orderId: string;
  buyerDid: string | null;
  buyerName: string | null;
  buyerHandle: string | null;
  buyerEmail: string | null;
  buyerAvatar: null;
  ticketType: string;
  quantity: number;
  /** Minor currency units. */
  amountTotal: number;
  currency: string;
  paymentMethod: string | null;
  stripeSessionId: string | null;
  paymentId: string | null;
  purchasedAt: string | null;
  tickets: { ticketId: string; status: string }[];
  status: string;
}

export interface SalesReport {
  sales: SaleView[];
  orphans: never[];
  orphanOrders: never[];
  summary: { totalSales: number; totalRevenue: number; avgOrderValue: number; totalOrders: number };
}

export type SalesResult = { kind: 'json'; report: SalesReport } | { kind: 'file'; file: CsvFile };

async function assertOrganizer(eventId: string, did: string, callerCookie?: string | null): Promise<void> {
  const check = await isEventOrganizer(eventId, did, callerCookie);
  if (!check.authorized) throw new ServiceError('forbidden', FORBIDDEN_MESSAGE);
}

/** Organizer check, then the event row (404 when missing) — shared by every sales read. */
async function loadEvent(eventId: string, actorDid: string, callerCookie?: string | null): Promise<SalesEventRow> {
  await assertOrganizer(eventId, actorDid, callerCookie);
  const event = await getSalesEvent(eventId);
  if (!event) throw new ServiceError('not_found', 'Event not found');
  return event;
}

function toIso(date: DateLike): string {
  return new Date(date).toISOString();
}

function uniqueDids(dids: (string | null)[]): string[] {
  return [...new Set(dids.filter((did): did is string => Boolean(did)))];
}

function lookup(did: string | null, identities: Identities): ResolvedProfile | undefined {
  return did ? identities.get(did) : undefined;
}

/** Attendee display name from survey answers (`full_name` preferred, then `name`). */
function attendeeNameOf(answers: SurveyAnswers | undefined): string | null {
  return answers?.full_name || answers?.name || null;
}

/** Order status derived from its tickets (the orders table status is not trusted). */
export function computeOrderStatus(tickets: { status: string }[]): string {
  if (tickets.length === 0) return UNKNOWN;
  const statuses = tickets.map((t) => t.status);
  if (statuses.every((s) => COMPLETED_TICKET_STATUSES.has(s))) return 'completed';
  if (statuses.every((s) => s === 'refunded')) return 'refunded';
  if (statuses.every((s) => s === 'cancelled')) return 'cancelled';
  if (statuses.includes('held')) return 'pending';
  if (statuses.some((s) => COMPLETED_TICKET_STATUSES.has(s))) return 'partial';
  return UNKNOWN;
}

function toSale(
  row: OrderSaleRow,
  tickets: SaleTicket[],
  buyerIdentities: Identities,
  fallbackCurrency: string | null,
): Sale {
  const buyer = lookup(row.buyer_did, buyerIdentities);
  return {
    transactionId: null,
    orderId: row.order_id,
    buyer: {
      did: row.buyer_did ?? null,
      name: buyer?.displayName ?? null,
      handle: buyer?.handle ?? null,
      email: buyer?.email ?? null,
    },
    tickets,
    amount: row.amount_total ? row.amount_total / 100 : 0,
    currency: row.currency ?? fallbackCurrency ?? 'USD',
    status: computeOrderStatus(tickets),
    paymentMethod: row.payment_method ?? null,
    stripeSessionId: row.stripe_session_id ?? null,
    createdAt: row.purchased_at ? toIso(row.purchased_at) : toIso(row.created_at),
  };
}

/** One `Sale` per order: the join rows are grouped by order, tickets de-duplicated by id. */
function groupOrderSales(
  rows: OrderSaleRow[],
  surveys: Map<string, SurveyResponse>,
  buyerIdentities: Identities,
  fallbackCurrency: string | null,
): Sale[] {
  const groups = new Map<string, { row: OrderSaleRow; tickets: SaleTicket[] }>();
  for (const row of rows) {
    const group = groups.get(row.order_id) ?? { row, tickets: [] };
    groups.set(row.order_id, group);
    const ticketId = row.ticket_id;
    if (ticketId && !group.tickets.some((t) => t.id === ticketId)) {
      group.tickets.push({
        id: ticketId,
        type: row.ticket_type_name ?? UNKNOWN_LABEL,
        attendeeName: attendeeNameOf(surveys.get(ticketId)?.answers),
        status: row.ticket_status ?? UNKNOWN,
      });
    }
  }
  return [...groups.values()].map((g) => toSale(g.row, g.tickets, buyerIdentities, fallbackCurrency));
}

/** Orders joined with tickets, survey attendee names (dykil) and batched buyer identities (kernel). */
async function fetchOrderSales(eventId: string, fallbackCurrency: string | null): Promise<Sale[]> {
  const rows = await listOrderSaleRows(eventId);
  const surveys = await getSurveyResponsesForTickets(
    rows.flatMap((r) => (r.ticket_id ? [{ ticketId: r.ticket_id, formId: r.registration_form_id }] : [])),
  );
  const buyerIdentities = await resolveProfiles(uniqueDids(rows.map((r) => r.buyer_did)));
  return groupOrderSales(rows, surveys, buyerIdentities, fallbackCurrency);
}

function toOrphanSaleView(
  row: OrphanTicketRow,
  answers: SurveyAnswers | undefined,
  ownerIdentities: Identities,
  fallbackCurrency: string,
): SaleView {
  const owner = lookup(row.owner_did, ownerIdentities);
  const status = row.status ?? UNKNOWN;
  const paymentId = row.payment_id ?? null;
  return {
    orderId: row.ticket_id,
    buyerDid: row.owner_did ?? null,
    buyerName: owner?.displayName ?? attendeeNameOf(answers),
    buyerHandle: owner?.handle ?? null,
    buyerEmail: owner?.email ?? null,
    buyerAvatar: null,
    ticketType: row.ticket_type_name ?? UNKNOWN_LABEL,
    quantity: 1,
    amountTotal: row.price_paid ?? 0,
    currency: row.currency ?? fallbackCurrency,
    paymentMethod: row.payment_method ?? null,
    stripeSessionId: paymentId?.startsWith('cs_') ? paymentId : null,
    paymentId,
    purchasedAt: row.purchased_at ? toIso(row.purchased_at) : null,
    tickets: [{ ticketId: row.ticket_id, status }],
    status: COMPLETED_TICKET_STATUSES.has(status) ? 'completed' : status,
  };
}

/** Tickets with no order (they predate the orders system), as sale lines with owner identities resolved. */
async function fetchOrphanSales(eventId: string, fallbackCurrency: string): Promise<SaleView[]> {
  const rows = await listOrphanTicketRows(eventId);
  const surveys = await getSurveyResponsesForTickets(
    rows.map((r) => ({ ticketId: r.ticket_id, formId: r.registration_form_id })),
  );
  const ownerIdentities = await resolveProfiles(uniqueDids(rows.map((r) => r.owner_did)));
  return rows.map((r) => toOrphanSaleView(r, surveys.get(r.ticket_id)?.answers, ownerIdentities, fallbackCurrency));
}

function countByType(tickets: SaleTicket[]): Record<string, number> {
  return tickets.reduce<Record<string, number>>((acc, t) => {
    acc[t.type] = (acc[t.type] || 0) + 1;
    return acc;
  }, {});
}

function toOrderSaleView(sale: Sale): SaleView {
  const ticketType =
    Object.entries(countByType(sale.tickets))
      .map(([type, qty]) => (qty > 1 ? `${type} (${qty})` : type))
      .join(', ') || UNKNOWN_LABEL;
  return {
    orderId: sale.orderId,
    buyerDid: sale.buyer.did,
    buyerName: sale.buyer.name,
    buyerHandle: sale.buyer.handle,
    buyerEmail: sale.buyer.email,
    buyerAvatar: null,
    ticketType,
    quantity: sale.tickets.length,
    amountTotal: Math.round(sale.amount * 100),
    currency: sale.currency,
    paymentMethod: sale.paymentMethod,
    stripeSessionId: sale.stripeSessionId,
    paymentId: sale.transactionId,
    purchasedAt: sale.createdAt,
    tickets: sale.tickets.map((t) => ({ ticketId: t.id, status: t.status })),
    status: sale.status,
  };
}

function timeOf(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
}

/** The unified sales list (orders + orphan tickets, newest first) the SalesTab UI renders. */
function buildReport(sales: Sale[], orphans: SaleView[]): SalesReport {
  const orphanRevenue = orphans.reduce((sum, o) => sum + o.amountTotal, 0) / 100;
  const totalRevenue = sales.reduce((sum, s) => sum + s.amount, 0) + orphanRevenue;
  const all = [...sales.map(toOrderSaleView), ...orphans].toSorted(
    (a, b) => timeOf(b.purchasedAt) - timeOf(a.purchasedAt),
  );
  const total = all.length;
  return {
    sales: all,
    orphans: [],
    orphanOrders: [],
    summary: {
      totalSales: total,
      totalRevenue: Math.round(totalRevenue * 100),
      avgOrderValue: total > 0 ? Math.round((totalRevenue * 100) / total) : 0,
      totalOrders: total,
    },
  };
}

/** A CSV download: BOM-prefixed header line plus one CSV line per row. */
export function buildCsvFile(filename: string, contentType: string, headers: string[], rows: unknown[][]): CsvFile {
  return { filename, contentType, content: CSV_BOM + csvRow(headers) + rows.map((row) => csvRow(row)).join('') };
}

/** `<title>-sales-<date>.<ext>` plus the matching content type, as a downloadable CSV. */
function toSalesFile(event: SalesEventRow, format: string | null | undefined, headers: string[], rows: unknown[][]): CsvFile {
  const xlsx = format === 'xlsx';
  const safeTitle = event.title
    ? event.title.replaceAll(/[^a-zA-Z0-9]+/g, '-').replaceAll(/^-|-$/g, '').toLowerCase()
    : event.id;
  const date = new Date().toISOString().split('T')[0];
  const filename = `${safeTitle || event.id}-sales-${date}.${xlsx ? 'xlsx' : 'csv'}`;
  return buildCsvFile(filename, xlsx ? XLSX_MIME : CSV_MIME, headers, rows);
}

function ticketTypesLabel(tickets: SaleTicket[]): string {
  return Object.entries(countByType(tickets))
    .map(([type, qty]) => `${type} (${qty})`)
    .join('; ');
}

function salesCsvRow(sale: Sale): unknown[] {
  return [
    sale.orderId,
    sale.transactionId ?? '',
    sale.buyer.name ?? '',
    sale.buyer.handle ?? '',
    sale.buyer.email ?? '',
    sale.buyer.did ?? '',
    ticketTypesLabel(sale.tickets),
    sale.tickets.length,
    sale.amount.toFixed(2),
    sale.currency,
    sale.status,
    sale.paymentMethod ?? '',
    sale.createdAt,
    sale.stripeSessionId ?? '',
  ];
}

/**
 * The sales of an event as the SalesTab JSON report, or (`format` csv / xlsx)
 * as a download. Orders and orphan tickets are always both read, as in the kernel.
 * Throws `forbidden` unless `actorDid` is the creator or a co-host, `not_found`
 * for an unknown event.
 */
export async function getEventSales(eventId: string, actorDid: string, options: SalesOptions = {}): Promise<SalesResult> {
  const event = await loadEvent(eventId, actorDid, options.callerCookie);
  const sales = await fetchOrderSales(eventId, event.currency);
  const orphans = await fetchOrphanSales(eventId, event.currency ?? 'CAD');
  if (options.format === 'csv' || options.format === 'xlsx') {
    return { kind: 'file', file: toSalesFile(event, options.format, SALES_HEADERS, sales.map(salesCsvRow)) };
  }
  return { kind: 'json', report: buildReport(sales, orphans) };
}

function groupTicketsByOrder(rows: TicketStatusRow[]) {
  const byOrder = new Map<string, { ticketId: string; status: string }[]>();
  for (const row of rows) {
    if (!row.order_id) continue;
    const list = byOrder.get(row.order_id) ?? [];
    list.push({ ticketId: row.id, status: row.status });
    byOrder.set(row.order_id, list);
  }
  return byOrder;
}

/** One CSV line per order, with its buyer identity, derived status and ticket ids/statuses. */
export async function exportEventSales(eventId: string, actorDid: string, options: SalesOptions = {}): Promise<CsvFile> {
  const event = await loadEvent(eventId, actorDid, options.callerCookie);
  const orders = await listExportOrderRows(eventId);
  const ticketsByOrder = groupTicketsByOrder(await listTicketStatusRows(eventId));
  const identities = await resolveProfiles(uniqueDids(orders.map((o) => o.buyer_did)));
  const rows = orders.map((o) => {
    const tickets = ticketsByOrder.get(o.order_id) ?? [];
    const buyer = lookup(o.buyer_did, identities);
    return [
      o.order_id,
      buyer?.displayName || '',
      buyer?.handle || '',
      buyer?.email || '',
      o.buyer_did || '',
      o.ticket_type,
      o.quantity,
      o.amount_total / 100,
      o.currency || 'CAD',
      computeOrderStatus(tickets.map((t) => ({ status: t.status }))),
      o.payment_method || '',
      o.stripe_session_id || '',
      o.payment_id || '',
      o.purchased_at ? toIso(o.purchased_at) : '',
      tickets.map((t) => t.ticketId).join('; '),
      tickets.map((t) => t.status).join('; '),
    ];
  });
  return toSalesFile(event, options.format, EXPORT_HEADERS, rows);
}
