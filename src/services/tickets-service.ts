/**
 * Ticket state transitions driven by organizers: cancel an unconfirmed ticket,
 * refund a valid one (Stripe / e-Transfer / free) and complete a pending
 * e-Transfer refund.
 */
import { createLogger } from '@ima-jin/logger';
import type { Ticket } from '@/db/schema';
import { findEventById } from '@/repositories/orders-repository';
import { decrementSold } from '@/repositories/ticket-types-repository';
import {
  cancelTicketRow,
  findTicketInEvent,
  findTicketStatus,
  loadRefundableTicket,
  markRefundSentRow,
  setTicketRefundStatus,
  type RefundableTicket,
  type TicketStatusRow,
} from '@/repositories/tickets-repository';
import { isEventOrganizer } from '@/services/authorization';
import { ServiceError } from '@/services/errors';
import { requestPayRefund } from '@/services/pay-refund';
import { notifyRefundCustomer } from '@/services/ticket-refund-notification';

const log = createLogger('events');

const TICKET_NOT_FOUND = 'Ticket not found';
const EVENT_NOT_FOUND = 'Event not found';

/** Who is acting on a ticket: the organizer's DID and their session cookie (for the co-host check). */
export interface TicketActor {
  actorDid: string;
  callerCookie?: string | null;
}

export interface TicketTarget extends TicketActor {
  eventId: string;
  ticketId: string;
}

export interface RefundTicketResult {
  ticket: TicketStatusRow;
  /** Present (true) only for e-Transfer refunds the organizer must send manually. */
  manualRefundRequired?: true;
  refundEmail?: string;
  refundAmount?: string;
  refundCurrency?: string;
}

async function assertOrganizer(
  target: TicketTarget,
  message: string,
): Promise<void> {
  const orgCheck = await isEventOrganizer(target.eventId, target.actorDid, target.callerCookie);
  if (!orgCheck.authorized) {
    throw new ServiceError('forbidden', message);
  }
}

async function assertEventExists(eventId: string) {
  const event = await findEventById(eventId);
  if (!event) {
    throw new ServiceError('not_found', EVENT_NOT_FOUND);
  }
  return event;
}

// ---------------------------------------------------------------------------
// cancelTicket
// ---------------------------------------------------------------------------

/**
 * Cancel a held or available (unconfirmed) ticket. Confirmed tickets must go
 * through a refund instead.
 */
export async function cancelTicket(target: TicketTarget): Promise<{ ticket: Ticket }> {
  const { eventId, ticketId } = target;
  await assertOrganizer(target, 'Not authorized');

  const ticket = await findTicketInEvent(eventId, ticketId);
  if (!ticket) {
    throw new ServiceError('not_found', TICKET_NOT_FOUND);
  }

  if (ticket.status !== 'held' && ticket.status !== 'available') {
    throw new ServiceError(
      'invalid',
      `Cannot cancel a ticket with status '${ticket.status}'. Only held or available tickets can be cancelled.`,
    );
  }

  const updated = await cancelTicketRow(ticketId);
  log.info({ ticketId, eventId, previousStatus: ticket.status }, 'Ticket cancelled');

  return { ticket: updated };
}

// ---------------------------------------------------------------------------
// refundTicket
// ---------------------------------------------------------------------------

/** Issue the actual Stripe refund through the pay service; a no-op for free / e-Transfer tickets. */
async function processPaymentRefund(ticket: RefundableTicket, pricePaid: number): Promise<void> {
  const isStripe = ticket.payment_method === 'stripe';
  if (!isStripe || !ticket.payment_id || pricePaid <= 0) return;

  const result = await requestPayRefund({ paymentId: ticket.payment_id, amount: pricePaid });
  if (!result.ok) {
    log.error(
      { status: result.status, text: result.text },
      '[refund] pay /api/refund returned error',
    );
    throw new ServiceError('unavailable', 'Payment refund failed — ticket status not changed', {
      status: 502,
    });
  }
}

/** Decrement the ticket type's sold counter — best-effort, failure is non-fatal. */
async function decrementSoldCounter(ticketTypeId: string | null): Promise<void> {
  if (!ticketTypeId) return;
  await decrementSold(ticketTypeId, 1).catch((err) => {
    log.error({ err: String(err) }, '[refund] Failed to decrement ticket_types.sold (non-fatal)');
  });
}

function buildRefundResult(
  updated: TicketStatusRow,
  manualRefundRequired: boolean,
  customerEmail: string | null,
  priceDollars: string,
  currency: string,
): RefundTicketResult {
  if (!manualRefundRequired) {
    return { ticket: { id: updated.id, status: updated.status } };
  }
  return {
    ticket: { id: updated.id, status: updated.status },
    manualRefundRequired: true,
    ...(customerEmail && { refundEmail: customerEmail }),
    refundAmount: priceDollars,
    refundCurrency: currency,
  };
}

/**
 * Refund a valid ticket (organizers only).
 *
 * - Stripe tickets: the pay service issues the actual refund before the status flips
 * - e-Transfer tickets: status becomes `refund_pending`; `manualRefundRequired` is returned
 * - Free tickets (price 0 / no payment method): no pay-service call
 * - The ticket type's sold counter is decremented (failure is non-fatal)
 */
export async function refundTicket(target: TicketTarget): Promise<RefundTicketResult> {
  const { eventId, ticketId, actorDid } = target;
  const event = await assertEventExists(eventId);

  // Refund is organizer-only (creator or cohost)
  await assertOrganizer(target, 'Only event organizers can issue refunds');

  const ticket = await loadRefundableTicket(eventId, ticketId);
  if (!ticket) {
    throw new ServiceError('not_found', TICKET_NOT_FOUND);
  }
  if (ticket.status !== 'valid') {
    throw new ServiceError('invalid', 'Only valid tickets can be refunded');
  }

  const isStripe = ticket.payment_method === 'stripe';
  const pricePaid = ticket.price_paid ?? 0;
  const manualRefundRequired = ticket.payment_method === 'etransfer';

  await processPaymentRefund(ticket, pricePaid);

  // Decrement sold counter — fail independently, don't block status update
  await decrementSoldCounter(ticket.ticket_type_id);

  // e-Transfer: refund_pending (organizer sends manually, then marks sent); otherwise refunded
  const updated = await setTicketRefundStatus(
    ticketId,
    manualRefundRequired ? 'refund_pending' : 'refunded',
  );

  const priceDollars = (pricePaid / 100).toFixed(2);
  const currency = ticket.currency || 'CAD';

  const customerEmail = await notifyRefundCustomer({
    did: actorDid,
    event,
    ticket,
    isStripe,
    pricePaid,
    manualRefundRequired,
    priceDollars,
    currency,
  });

  return buildRefundResult(updated, manualRefundRequired, customerEmail, priceDollars, currency);
}

// ---------------------------------------------------------------------------
// markRefundSent
// ---------------------------------------------------------------------------

/** Complete a pending e-Transfer refund: `refund_pending` -> `refunded` (organizers only). */
export async function markRefundSent(target: TicketTarget): Promise<{ ticket: TicketStatusRow }> {
  const { eventId, ticketId } = target;
  await assertEventExists(eventId);
  await assertOrganizer(target, 'Only event organizers can mark refunds as sent');

  const ticket = await findTicketStatus(eventId, ticketId);
  if (!ticket) {
    throw new ServiceError('not_found', TICKET_NOT_FOUND);
  }
  if (ticket.status !== 'refund_pending') {
    throw new ServiceError('invalid', 'Ticket is not in refund_pending status');
  }

  const updated = await markRefundSentRow(ticketId);
  return { ticket: { id: updated.id, status: updated.status } };
}
