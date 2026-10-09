import { randomBytes } from 'node:crypto';
import { createLogger, type Logger } from '@ima-jin/logger';
import type { NewOrder, Order, Ticket, TicketType } from '@/db/schema';
import { publish } from '@/lib/domain-events';
import { findOrderById, insertOrder, markOrderRefunded } from '@/repositories/orders-repository';
import { decrementSold, incrementSold } from '@/repositories/ticket-types-repository';
import {
  findRefundableTicketsByOrder,
  insertTicket,
  markTicketsRefunded,
  type TicketInsert,
} from '@/repositories/tickets-repository';
import { isEventOrganizer } from '@/services/authorization';
import type { CartItem } from '@/services/cart-validation';
import { ServiceError } from '@/services/errors';
import { requestPayRefund } from '@/services/pay-refund';
import { resolveTicketSignature, type TicketSigningContext } from '@/services/ticket-signing';

export { validateCart } from '@/services/cart-validation';
export type {
  CartItem,
  EventMetadata,
  ValidateCartOptions,
  ValidatedCart,
} from '@/services/cart-validation';

const log = createLogger('events');

export interface CreateOrderWithTicketsParams {
  orderId?: string;
  eventId: string;
  buyerDid: string;
  buyerEmail?: string;
  cart: CartItem[];
  typesById: Map<string, TicketType>;
  totalQuantity: number;
  totalAmount: number;
  currency: string;
  paymentMethod: 'stripe' | 'etransfer' | 'free' | 'balance';
  ticketStatus: 'valid' | 'held';
  holdExpiresAt?: Date;
  stripeSessionId?: string;
  paymentId?: string;
  orderMetadata?: Record<string, unknown>;
  ticketMetadata?: Record<string, unknown>;
  eventDid?: string;
  eventPrivateKey?: string | null;
  customerEmail?: string;
  log?: Logger;
  incrementSold?: boolean;
}

export interface CreateOrderWithTicketsResult {
  order: Order;
  tickets: Ticket[];
}

function generateOrderId(): string {
  return `ord_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function generateTicketId(index: number): string {
  return `tkt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}_${index}`;
}

function buildOrderInsertValues(orderId: string, params: CreateOrderWithTicketsParams): NewOrder {
  const {
    eventId, buyerDid, buyerEmail, cart, totalQuantity, totalAmount, currency,
    paymentMethod, ticketStatus, stripeSessionId, paymentId, orderMetadata,
  } = params;

  return {
    id: orderId,
    eventId,
    buyerDid,
    ticketTypeId: cart.length === 1 ? cart[0].ticketTypeId : null,
    quantity: totalQuantity,
    amountTotal: totalAmount,
    currency: currency.toUpperCase(),
    paymentMethod,
    stripeSessionId: stripeSessionId || null,
    paymentId: paymentId || null,
    status: ticketStatus === 'held' ? 'pending' : 'completed',
    purchasedAt: ticketStatus === 'valid' ? new Date() : null,
    metadata: orderMetadata || {},
    buyerEmail: buyerEmail || null,
  };
}

function buildTicketInsertValues(
  ticketId: string,
  item: CartItem,
  tt: TicketType,
  order: Order,
  signature: string | null,
  params: CreateOrderWithTicketsParams,
): TicketInsert {
  const {
    eventId, buyerDid, currency, paymentMethod, ticketStatus, holdExpiresAt,
    stripeSessionId, paymentId, ticketMetadata,
  } = params;

  return {
    id: ticketId,
    eventId,
    ticketTypeId: item.ticketTypeId,
    ownerDid: buyerDid,
    orderId: order.id,
    originalOwnerDid: buyerDid,
    pricePaid: tt.price,
    currency: currency.toUpperCase(),
    paymentId: ticketStatus === 'valid' ? paymentId || stripeSessionId || null : null,
    paymentMethod,
    status: ticketStatus,
    purchasedAt: ticketStatus === 'valid' ? new Date() : null,
    signature,
    heldBy: ticketStatus === 'held' ? buyerDid : null,
    heldUntil: holdExpiresAt || null,
    holdExpiresAt: holdExpiresAt || null,
    registrationStatus: tt.requiresRegistration ? 'pending' : 'not_required',
    metadata: ticketMetadata || {},
  };
}

function signingContext(params: CreateOrderWithTicketsParams): TicketSigningContext {
  const { eventId, eventDid, eventPrivateKey, log: callerLog } = params;
  return { eventId, eventDid, eventPrivateKey, log: callerLog };
}

async function insertTicketsForCart(
  order: Order,
  params: CreateOrderWithTicketsParams,
): Promise<Ticket[]> {
  const { cart, typesById, ticketStatus, customerEmail } = params;
  const pending = cart.flatMap((item) =>
    Array.from({ length: item.quantity }, () => ({ item, tt: typesById.get(item.ticketTypeId)! })),
  );

  return Promise.all(
    pending.map(async ({ item, tt }, idx) => {
      const ticketId = generateTicketId(idx);
      const signature = await resolveTicketSignature(
        ticketId,
        ticketStatus,
        customerEmail,
        signingContext(params),
      );
      return insertTicket(buildTicketInsertValues(ticketId, item, tt, order, signature, params));
    }),
  );
}

async function incrementSoldCounts(cart: CartItem[]): Promise<void> {
  await Promise.all(cart.map((item) => incrementSold(item.ticketTypeId, item.quantity)));
}

/**
 * Create an order and its associated tickets.
 *
 * Handles both held (e-Transfer pending) and valid (paid) tickets.
 * Ed25519 signing is performed when eventPrivateKey is provided and
 * ticketStatus is 'valid'.
 *
 * Optionally increments the sold count on ticket types.
 */
export async function createOrderWithTickets(
  params: CreateOrderWithTicketsParams,
): Promise<CreateOrderWithTicketsResult> {
  const orderId = params.orderId ?? generateOrderId();

  const order = await insertOrder(buildOrderInsertValues(orderId, params));
  const createdTickets = await insertTicketsForCart(order, params);

  if (params.incrementSold) {
    await incrementSoldCounts(params.cart);
  }

  return { order, tickets: createdTickets };
}

// ---------------------------------------------------------------------------
// refundOrder
// ---------------------------------------------------------------------------

export interface RefundOrderInput {
  orderId: string;
  /** DID of the organizer issuing the refund. */
  actorDid: string;
  /** The caller's session cookie, forwarded for the co-host pod-membership check. */
  callerCookie?: string | null;
}

export interface RefundOrderResult {
  orderId: string;
  refundedTickets: number;
  status: 'refunded';
}

async function loadOrderForRefund(input: RefundOrderInput): Promise<Order> {
  const order = await findOrderById(input.orderId);
  if (!order) {
    throw new ServiceError('not_found', 'Order not found');
  }
  if (order.status === 'refunded') {
    throw new ServiceError('invalid', 'Order already refunded');
  }

  const orgCheck = await isEventOrganizer(order.eventId, input.actorDid, input.callerCookie);
  if (!orgCheck.authorized) {
    throw new ServiceError('forbidden', 'Only event organizers can issue refunds');
  }
  return order;
}

/** Full Stripe refund via the pay service (no `amount` = full). Fails the whole refund when pay rejects. */
async function refundWithPayService(paymentId: string): Promise<void> {
  const result = await requestPayRefund({ paymentId, reason: 'order refund' });
  if (!result.ok) {
    log.error(
      { status: result.status, text: result.text },
      '[order-refund] pay /api/refund returned error',
    );
    throw new ServiceError('unavailable', 'Payment refund failed — order status not changed', {
      status: 502,
    });
  }
}

/** Give refunded tickets back to their types' sold counters — non-fatal per type. */
async function releaseSoldCounters(refunded: Ticket[]): Promise<void> {
  const typeIds = [...new Set(refunded.map((t) => t.ticketTypeId))];
  await Promise.all(
    typeIds.map((typeId) => {
      const count = refunded.filter((t) => t.ticketTypeId === typeId).length;
      return decrementSold(typeId, count).catch((err) => {
        log.error(
          { err: String(err) },
          '[order-refund] Failed to decrement ticket_types.sold (non-fatal)',
        );
      });
    }),
  );
}

function publishOrderRefunded(
  actorDid: string,
  order: Order,
  ticketIds: string[],
  isStripe: boolean,
): void {
  publish('order.refunded', {
    issuer: actorDid,
    subject: order.buyerDid || 'unknown',
    scope: 'events',
    payload: {
      orderId: order.id,
      eventId: order.eventId,
      ticketIds,
      amountTotal: order.amountTotal,
      currency: order.currency,
      isStripe,
    },
  }).catch((err) =>
    log.error({ err: String(err) }, '[order-refund] Failed to publish order.refunded'),
  );
}

/**
 * Refund an entire order atomically (organizer-only).
 *
 * - Stripe orders: full Stripe refund through the pay service first; if pay
 *   fails nothing is changed (502).
 * - Free / e-Transfer orders: tickets are marked directly (no pay call).
 *
 * Then all valid/used tickets become `refunded`, sold counters are decremented
 * (non-fatal), the order becomes `refunded` and `order.refunded` is published.
 */
export async function refundOrder(input: RefundOrderInput): Promise<RefundOrderResult> {
  const order = await loadOrderForRefund(input);

  const orderTickets = await findRefundableTicketsByOrder(order.id);
  if (orderTickets.length === 0) {
    throw new ServiceError('invalid', 'No refundable tickets found in this order');
  }

  const stripePaymentId = order.paymentMethod === 'stripe' ? order.paymentId : null;
  const isStripe = Boolean(stripePaymentId);
  if (stripePaymentId) {
    await refundWithPayService(stripePaymentId);
  }

  const ticketIds = orderTickets.map((t) => t.id);
  await markTicketsRefunded(ticketIds);
  await releaseSoldCounters(orderTickets);
  await markOrderRefunded(order.id);

  publishOrderRefunded(input.actorDid, order, ticketIds, isStripe);

  return { orderId: order.id, refundedTickets: ticketIds.length, status: 'refunded' };
}
