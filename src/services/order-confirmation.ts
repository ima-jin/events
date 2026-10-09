/**
 * e-Transfer payment confirmation: the `held` -> `valid` ticket transition and
 * the `pending` -> `completed` order transition, plus the organizer-gated
 * entry points used by the per-order and per-ticket confirm routes.
 */
import { createLogger } from '@ima-jin/logger';
import type { Ticket } from '@/db/schema';
import { publish } from '@/lib/domain-events';
import {
  findEventById,
  findOrderById,
  markOrderCompleted,
} from '@/repositories/orders-repository';
import { incrementSold } from '@/repositories/ticket-types-repository';
import {
  findHeldEtransferTicketsByOrder,
  findTicketById,
  markHeldTicketsValid,
} from '@/repositories/tickets-repository';
import { isEventOrganizer } from '@/services/authorization';
import { ServiceError } from '@/services/errors';
import { sendConfirmationEmails } from '@/services/order-confirmation-emails';

const log = createLogger('events');

const NOT_AUTHORIZED = 'Not authorized';

export interface ConfirmPaymentResult {
  confirmedTickets: Ticket[];
  orderId: string | null;
}

/** Who is confirming: the organizer's DID and their session cookie (for the co-host check). */
export interface ConfirmActor {
  actorDid: string;
  callerCookie?: string | null;
}

export interface ConfirmOrderPaymentResult {
  confirmedCount: number;
  orderId: string;
  tickets: string[];
}

export interface ConfirmTicketPaymentResult {
  ticket: Ticket;
  confirmedCount: number;
  orderId: string | null;
}

async function incrementSoldPerType(confirmedTickets: Ticket[]): Promise<void> {
  const byType = new Map<string, number>();
  for (const t of confirmedTickets) {
    byType.set(t.ticketTypeId, (byType.get(t.ticketTypeId) ?? 0) + 1);
  }
  await Promise.all(
    Array.from(byType.entries(), ([ticketTypeId, count]) => incrementSold(ticketTypeId, count)),
  );
}

function publishTicketPurchased(ticket: Ticket, creatorDid: string | undefined): void {
  publish('ticket.purchased', {
    issuer: ticket.ownerDid || '',
    subject: creatorDid ?? ticket.eventId,
    scope: 'events',
    payload: {
      ticketId: ticket.id,
      eventId: ticket.eventId,
      amount: ticket.pricePaid ?? 0,
      currency: ticket.currency || 'USD',
      context_id: ticket.eventId,
      context_type: 'event',
    },
  }).catch((err) => log.error({ err: String(err) }, 'Publish error'));
}

/**
 * Confirm all held e-Transfer tickets in an order (or a single orphan ticket)
 * and send the buyer their receipt + ticket bundle email.
 */
export async function confirmHeldTickets(
  eventId: string,
  heldTickets: Ticket[],
  orderId: string | null,
): Promise<ConfirmPaymentResult> {
  const now = new Date();

  if (heldTickets.length === 0) {
    throw new Error('No held tickets to confirm');
  }

  const confirmedTickets = await markHeldTicketsValid(
    heldTickets.map((t) => t.id),
    now,
  );

  if (orderId) {
    await markOrderCompleted(orderId, now);
  }

  if (confirmedTickets.length > 0) {
    await incrementSoldPerType(confirmedTickets);
  }

  // Fetch event for attestations + emails
  const event = await findEventById(eventId);

  for (const t of confirmedTickets) {
    publishTicketPurchased(t, event?.creatorDid);
  }

  if (event) {
    try {
      await sendConfirmationEmails(event, confirmedTickets, orderId);
    } catch (emailErr) {
      log.error({ err: String(emailErr) }, 'EMT confirm email block failed');
    }
  }

  return { confirmedTickets, orderId };
}

async function assertOrganizer(eventId: string, actor: ConfirmActor): Promise<void> {
  const orgCheck = await isEventOrganizer(eventId, actor.actorDid, actor.callerCookie);
  if (!orgCheck.authorized) {
    throw new ServiceError('forbidden', NOT_AUTHORIZED);
  }
}

/**
 * Organizer confirms an e-Transfer payment for a whole order: every held
 * e-Transfer ticket becomes valid and the order completes.
 */
export async function confirmOrderPayment(
  orderId: string,
  actor: ConfirmActor,
): Promise<ConfirmOrderPaymentResult> {
  const order = await findOrderById(orderId);
  if (!order) {
    throw new ServiceError('not_found', 'Order not found');
  }
  if (order.status !== 'pending') {
    throw new ServiceError('invalid', 'Order is not in pending status');
  }

  await assertOrganizer(order.eventId, actor);

  const heldTickets = await findHeldEtransferTicketsByOrder(orderId);
  if (heldTickets.length === 0) {
    throw new ServiceError('invalid', 'No held e-Transfer tickets found in this order');
  }

  const { confirmedTickets } = await confirmHeldTickets(order.eventId, heldTickets, orderId);

  return {
    confirmedCount: confirmedTickets.length,
    orderId,
    tickets: confirmedTickets.map((t) => t.id),
  };
}

/**
 * DEPRECATED path: organizer confirms a single held e-Transfer ticket. When
 * the ticket belongs to an order every held sibling is confirmed atomically;
 * otherwise only this orphan ticket is.
 */
export async function confirmTicketPayment(
  ticketId: string,
  actor: ConfirmActor,
): Promise<ConfirmTicketPaymentResult> {
  const ticket = await findTicketById(ticketId);
  if (!ticket) {
    throw new ServiceError('not_found', 'Ticket not found');
  }
  if (ticket.status !== 'held') {
    throw new ServiceError('invalid', 'Ticket is not in held status');
  }
  if (ticket.paymentMethod !== 'etransfer') {
    throw new ServiceError('invalid', 'Ticket is not an e-Transfer hold');
  }

  await assertOrganizer(ticket.eventId, actor);

  const heldTickets = ticket.orderId
    ? await findHeldEtransferTicketsByOrder(ticket.orderId)
    : [ticket];

  const { confirmedTickets } = await confirmHeldTickets(ticket.eventId, heldTickets, ticket.orderId);

  return {
    ticket: confirmedTickets[0],
    confirmedCount: confirmedTickets.length,
    orderId: ticket.orderId ?? null,
  };
}
