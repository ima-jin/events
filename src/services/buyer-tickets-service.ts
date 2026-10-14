import type { BuyerOrder, BuyerTicket, FairSettlement } from '@/lib/buyer-tickets';
import { isPodMember } from '@/lib/kernel';
import { getBuyerEventAccess, listOwnedTicketRows, type BuyerTicketRow } from '@/repositories/buyer-tickets-repository';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function role(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function receiptChain(value: unknown): FairSettlement['chain'] | null {
  if (!Array.isArray(value)) return null;
  const chain: FairSettlement['chain'] = [];
  for (const entry of value) {
    if (!record(entry) || typeof entry.did !== 'string' || !/^did:imajin:[\w.:-]+$/.test(entry.did)
      || !amount(entry.amount) || !role(entry.role)) return null;
    chain.push({ did: entry.did, amount: entry.amount, role: entry.role });
  }
  return chain;
}

function receiptFees(value: unknown): NonNullable<FairSettlement['fees']> | null {
  if (!Array.isArray(value)) return null;
  const fees: NonNullable<FairSettlement['fees']> = [];
  for (const fee of value) {
    if (!record(fee) || !role(fee.role) || typeof fee.name !== 'string' || fee.name.length > 120
      || fee.name.includes('@') || !amount(fee.rateBps) || !amount(fee.fixedCents) || !amount(fee.amount)
      || (fee.estimated !== undefined && typeof fee.estimated !== 'boolean')) return null;
    fees.push({
      role: fee.role, name: fee.name, rateBps: fee.rateBps, fixedCents: fee.fixedCents, amount: fee.amount,
      ...(typeof fee.estimated === 'boolean' && { estimated: fee.estimated }),
    });
  }
  return fees;
}

/** Reject malformed receipts; copy only fields safe for the buyer receipt UI. */
function settlement(value: unknown): FairSettlement | null {
  if (!record(value) || typeof value.settledAt !== 'string' || !amount(value.totalAmount)
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) return null;
  const settledAt = isoDate(value.settledAt);
  const chain = receiptChain(value.chain);
  if (!settledAt || !chain || (value.netAmount !== undefined && !amount(value.netAmount))) return null;
  if (value.version !== undefined && (typeof value.version !== 'string' || !/^\d+\.\d+$/.test(value.version))) return null;
  const fees = value.fees === undefined ? undefined : receiptFees(value.fees);
  if (fees === null) return null;
  return {
    settledAt, totalAmount: value.totalAmount, currency: value.currency, chain,
    ...(typeof value.version === 'string' && { version: value.version }),
    ...(typeof value.netAmount === 'number' && { netAmount: value.netAmount }),
    ...(fees && { fees }),
  };
}

function buyerTicket({ ticket, ticketType }: BuyerTicketRow): BuyerTicket {
  return {
    id: ticket.id,
    status: ticket.status,
    usedAt: isoDate(ticket.usedAt),
    registrationStatus: ticket.registrationStatus || 'not_required',
    pricePaid: ticket.pricePaid,
    currency: ticket.currency,
    ticketType: ticketType ? {
      name: ticketType.name,
      description: ticketType.description,
      perks: Array.isArray(ticketType.perks) ? ticketType.perks.filter((perk): perk is string => typeof perk === 'string') : [],
      registrationFormId: ticketType.registrationFormId ?? null,
    } : null,
  };
}

function typeSummary(rows: BuyerTicketRow[]): string {
  const counts = new Map<string, number>();
  for (const { ticketType } of rows) {
    const name = ticketType?.name || 'Ticket';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => count > 1 ? `${count}× ${name}` : name).join(' + ');
}

function ownedTotal(rows: BuyerTicketRow[]) {
  const currency = rows[0].ticket.currency;
  const completePrices = rows.every(({ ticket }) => ticket.pricePaid !== null && ticket.currency === currency);
  return {
    totalAmount: completePrices && currency ? rows.reduce((total, { ticket }) => total + (ticket.pricePaid ?? 0), 0) : null,
    currency: completePrices ? currency : null,
  };
}

function buyerOrder(rows: BuyerTicketRow[], ownerDid: string): BuyerOrder {
  const { ticket, order } = rows[0];
  const isLegacy = !ticket.orderId;
  // Neither a transferred recipient nor a purchaser retaining only part of
  // an order may learn what was paid/settled for someone else's tickets.
  const fullPurchase = order?.buyerDid === ownerDid && order.quantity === rows.length;
  const totals = fullPurchase ? { totalAmount: order.amountTotal, currency: order.currency } : ownedTotal(rows);
  let fairSettlement: FairSettlement | null = null;
  if (isLegacy) fairSettlement = settlement(ticket.legacyFairSettlement);
  if (fullPurchase) fairSettlement = settlement(order.fairSettlement ?? ticket.legacyFairSettlement);
  return {
    id: ticket.orderId ?? ticket.id,
    isLegacy,
    quantity: rows.length,
    ...totals,
    purchasedAt: isoDate(ticket.purchasedAt ?? ticket.createdAt),
    ticketTypeName: typeSummary(rows),
    fairSettlement,
    tickets: rows.map(buyerTicket),
  };
}

function groupOrders(rows: BuyerTicketRow[], ownerDid: string): BuyerOrder[] {
  const groups = new Map<string, BuyerTicketRow[]>();
  for (const row of rows) {
    const key = row.ticket.orderId ? `order:${row.ticket.orderId}` : `legacy:${row.ticket.id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values(), (group) => buyerOrder(group, ownerDid));
}

/** Public registration service URL only: never credentials, query tokens or fragments. */
function registrationEmbedBaseUrl(): string | null {
  try {
    const url = new URL(process.env.DYKIL_URL ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    let path = url.pathname;
    while (path.endsWith('/')) path = path.slice(0, -1);
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

export async function getBuyerTickets(eventId: string, ownerDid: string, callerCookie: string | null) {
  const rows = await listOwnedTicketRows(eventId, ownerDid);
  const event = await getBuyerEventAccess(eventId);
  let isOrganizer = event?.creatorDid === ownerDid;
  if (!isOrganizer && event?.podId) {
    isOrganizer = await isPodMember(event.podId, ownerDid, ['owner', 'host', 'cohost'], callerCookie);
  }
  const hasTicket = rows.length > 0;
  return {
    hasTicket,
    hasAccess: hasTicket || isOrganizer,
    isOrganizer,
    tickets: rows.map((row) => {
      const projected = buyerTicket(row);
      const ticketType = projected.ticketType;
      return {
        id: projected.id, status: projected.status, purchasedAt: isoDate(row.ticket.purchasedAt),
        pricePaid: projected.pricePaid, currency: projected.currency,
        ticketType: ticketType ? { name: ticketType.name, description: ticketType.description, perks: ticketType.perks } : null,
      };
    }),
    ticketId: rows[0]?.ticket.id || null,
    orders: groupOrders(rows, ownerDid),
    registrationEmbedBaseUrl: registrationEmbedBaseUrl(),
  };
}
