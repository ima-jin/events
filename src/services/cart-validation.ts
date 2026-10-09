import type { TicketType } from '@/db/schema';
import { findTicketTypesByEvent } from '@/repositories/ticket-types-repository';
import { releaseExpiredHolds } from '@/repositories/tickets-repository';
import { ServiceError } from '@/services/errors';

export interface CartItem {
  ticketTypeId: string;
  quantity: number;
}

/** Free-form event metadata JSON; only the keys the checkout reads are typed. */
export interface EventMetadata {
  maxTicketsPerOrder?: number;
  fair?: unknown;
  [key: string]: unknown;
}

export interface ValidateCartOptions {
  checkAvailability?: boolean;
  availabilityStatusCode?: number;
  checkMaxPerOrder?: boolean;
  eventMetadata?: EventMetadata;
  releaseExpiredHolds?: boolean;
}

export interface ValidatedCart {
  typesById: Map<string, TicketType>;
  totalQuantity: number;
  totalAmount: number;
  currency: string;
}

const DEFAULT_MAX_PER_ORDER = 10;
const HARD_MAX_PER_ORDER = 20;

async function fetchTicketTypesById(eventId: string): Promise<Map<string, TicketType>> {
  const fetchedTypes = await findTicketTypesByEvent(eventId);
  return new Map(fetchedTypes.map((t) => [t.id, t]));
}

function getCartItemTicketType(item: CartItem, typesById: Map<string, TicketType>): TicketType {
  const tt = typesById.get(item.ticketTypeId);
  if (!tt) {
    throw new ServiceError('not_found', `Ticket type ${item.ticketTypeId} not found for this event`);
  }
  return tt;
}

function assertMaxPerOrder(
  item: CartItem,
  tt: TicketType,
  metadataMaxTicketsPerOrder: number | undefined,
): void {
  const maxPerOrder = Math.min(
    tt.maxPerOrder ?? metadataMaxTicketsPerOrder ?? DEFAULT_MAX_PER_ORDER,
    HARD_MAX_PER_ORDER,
  );
  if (item.quantity > maxPerOrder) {
    throw new ServiceError('invalid', `Maximum ${maxPerOrder} tickets per order`);
  }
}

function assertAvailability(item: CartItem, tt: TicketType, availabilityStatusCode: number): void {
  if (tt.quantity === null) return;
  const available = tt.quantity - (tt.sold ?? 0);
  if (available < item.quantity) {
    const suffix = available === 1 ? '' : 's';
    throw new ServiceError('conflict', `Only ${available} ${tt.name} ticket${suffix} available`, {
      status: availabilityStatusCode,
    });
  }
}

function assertSingleCurrency(items: CartItem[], typesById: Map<string, TicketType>): void {
  const currencies = new Set(items.map((c) => typesById.get(c.ticketTypeId)!.currency));
  if (currencies.size > 1) {
    throw new ServiceError('invalid', 'All tickets in a cart must use the same currency');
  }
}

function computeCartTotals(
  items: CartItem[],
  typesById: Map<string, TicketType>,
): { totalQuantity: number; totalAmount: number; currency: string } {
  const totalQuantity = items.reduce((sum, c) => sum + c.quantity, 0);
  const totalAmount = items.reduce(
    (sum, item) => sum + typesById.get(item.ticketTypeId)!.price * item.quantity,
    0,
  );
  const currency = typesById.get(items[0].ticketTypeId)!.currency;
  return { totalQuantity, totalAmount, currency };
}

/**
 * Fetch ticket types for an event, validate cart items, and compute totals.
 *
 * Checks performed (when enabled via options):
 * - Every item references a ticket type that belongs to the event (404)
 * - maxPerOrder limit per type (with event metadata fallback, capped at 20) (400)
 * - Availability: quantity - sold >= requested quantity (409, or `availabilityStatusCode`)
 * - All items share the same currency (400)
 */
export async function validateCart(
  eventId: string,
  items: CartItem[],
  options: ValidateCartOptions = {},
): Promise<ValidatedCart> {
  const {
    checkAvailability = false,
    availabilityStatusCode = 409,
    checkMaxPerOrder = false,
    eventMetadata,
    releaseExpiredHolds: shouldReleaseExpiredHolds = false,
  } = options;

  const typesById = await fetchTicketTypesById(eventId);

  if (shouldReleaseExpiredHolds) {
    await Promise.all(items.map((item) => releaseExpiredHolds(item.ticketTypeId, new Date())));
  }

  for (const item of items) {
    const tt = getCartItemTicketType(item, typesById);

    if (checkMaxPerOrder) {
      assertMaxPerOrder(item, tt, eventMetadata?.maxTicketsPerOrder);
    }
    if (checkAvailability) {
      assertAvailability(item, tt, availabilityStatusCode);
    }
  }

  assertSingleCurrency(items, typesById);
  const { totalQuantity, totalAmount, currency } = computeCartTotals(items, typesById);

  return { typesById, totalQuantity, totalAmount, currency };
}
