import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUYER_DID,
  BUYER_EMAIL,
  EVENT_ID,
  ORGANIZER_DID,
  TICKET_ID,
  TYPE_ID,
  isEventOrganizerMock,
  logMock,
  makeEvent,
  makeTicket,
  resetOrdersMocks,
} from '@/__tests__/support/orders-support';

vi.mock('@ima-jin/logger', async () => (await import('@/__tests__/support/orders-support')).loggerModuleMock());
vi.mock('@/services/authorization', async () =>
  (await import('@/__tests__/support/orders-support')).authorizationModuleMock(),
);
vi.mock('@/repositories/orders-repository', async () =>
  (await import('@/__tests__/support/orders-support')).ordersRepositoryMock(),
);
vi.mock('@/repositories/tickets-repository', async () =>
  (await import('@/__tests__/support/orders-support')).ticketsRepositoryMock(),
);
vi.mock('@/repositories/ticket-types-repository', async () =>
  (await import('@/__tests__/support/orders-support')).ticketTypesRepositoryMock(),
);
vi.mock('@/services/pay-refund', () => ({ requestPayRefund: vi.fn() }));
vi.mock('@/services/ticket-refund-notification', () => ({ notifyRefundCustomer: vi.fn() }));

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
} from '@/repositories/tickets-repository';
import { ServiceError } from '@/services/errors';
import { requestPayRefund } from '@/services/pay-refund';
import { notifyRefundCustomer } from '@/services/ticket-refund-notification';
import { cancelTicket, markRefundSent, refundTicket } from '@/services/tickets-service';

const TARGET = { eventId: EVENT_ID, ticketId: TICKET_ID, actorDid: ORGANIZER_DID, callerCookie: 'session=abc' };

const stripeTicket: RefundableTicket = {
  id: TICKET_ID,
  status: 'valid',
  price_paid: 27500,
  payment_id: 'pi_test',
  payment_method: 'stripe',
  ticket_type_id: TYPE_ID,
  owner_did: BUYER_DID,
  currency: 'CAD',
};
const etransferTicket: RefundableTicket = { ...stripeTicket, payment_method: 'etransfer', payment_id: null };
const freeTicket: RefundableTicket = { ...stripeTicket, price_paid: 0, payment_id: null, payment_method: null };

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

function stockRefund(ticket: RefundableTicket | null, resultingStatus = 'refunded'): void {
  vi.mocked(loadRefundableTicket).mockResolvedValue(ticket);
  vi.mocked(setTicketRefundStatus).mockResolvedValue({ id: TICKET_ID, status: resultingStatus });
}

beforeEach(() => {
  resetOrdersMocks();
  vi.mocked(findEventById).mockResolvedValue(makeEvent());
  vi.mocked(decrementSold).mockResolvedValue(undefined);
  vi.mocked(requestPayRefund).mockResolvedValue({ ok: true });
  vi.mocked(notifyRefundCustomer).mockResolvedValue(BUYER_EMAIL);
  stockRefund(stripeTicket);
});

describe('cancelTicket', () => {
  beforeEach(() => {
    vi.mocked(findTicketInEvent).mockResolvedValue(makeTicket({ status: 'held' }));
    vi.mocked(cancelTicketRow).mockResolvedValue(makeTicket({ status: 'cancelled' }));
  });

  it('403s for non-organizers, forwarding the caller cookie, before reading the ticket', async () => {
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    expect(await failure(cancelTicket(TARGET))).toMatchObject({ status: 403, message: 'Not authorized' });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, 'session=abc');
    expect(findTicketInEvent).not.toHaveBeenCalled();
  });

  it('404s for a ticket outside the event', async () => {
    vi.mocked(findTicketInEvent).mockResolvedValue(null);

    expect(await failure(cancelTicket(TARGET))).toMatchObject({ status: 404, message: 'Ticket not found' });
    expect(findTicketInEvent).toHaveBeenCalledWith(EVENT_ID, TICKET_ID);
  });

  it('400s for confirmed tickets, naming the status', async () => {
    vi.mocked(findTicketInEvent).mockResolvedValue(makeTicket({ status: 'valid' }));

    expect(await failure(cancelTicket(TARGET))).toMatchObject({
      status: 400,
      message: "Cannot cancel a ticket with status 'valid'. Only held or available tickets can be cancelled.",
    });
    expect(cancelTicketRow).not.toHaveBeenCalled();
  });

  it.each(['held', 'available'])('cancels a %s ticket and logs the previous status', async (status) => {
    vi.mocked(findTicketInEvent).mockResolvedValue(makeTicket({ status }));

    const result = await cancelTicket(TARGET);

    expect(result.ticket.status).toBe('cancelled');
    expect(cancelTicketRow).toHaveBeenCalledWith(TICKET_ID);
    expect(logMock.info).toHaveBeenCalledWith(
      { ticketId: TICKET_ID, eventId: EVENT_ID, previousStatus: status },
      'Ticket cancelled',
    );
  });
});

describe('refundTicket — guards', () => {
  it('404s for an unknown event before any organizer check', async () => {
    vi.mocked(findEventById).mockResolvedValue(null);

    expect(await failure(refundTicket(TARGET))).toMatchObject({ status: 404, message: 'Event not found' });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  it('403s for non-organizers', async () => {
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    expect(await failure(refundTicket(TARGET))).toMatchObject({
      status: 403,
      message: 'Only event organizers can issue refunds',
    });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, 'session=abc');
    expect(loadRefundableTicket).not.toHaveBeenCalled();
  });

  it('404s for an unknown ticket', async () => {
    stockRefund(null);

    expect(await failure(refundTicket(TARGET))).toMatchObject({ status: 404, message: 'Ticket not found' });
    expect(loadRefundableTicket).toHaveBeenCalledWith(EVENT_ID, TICKET_ID);
  });

  it('400s for tickets that are not valid', async () => {
    stockRefund({ ...stripeTicket, status: 'refunded' });

    expect(await failure(refundTicket(TARGET))).toMatchObject({
      status: 400,
      message: 'Only valid tickets can be refunded',
    });
    expect(requestPayRefund).not.toHaveBeenCalled();
  });
});

describe('refundTicket — payment', () => {
  it('refunds a Stripe ticket through pay for the price paid, then flips to refunded', async () => {
    const result = await refundTicket(TARGET);

    expect(requestPayRefund).toHaveBeenCalledWith({ paymentId: 'pi_test', amount: 27500 });
    expect(decrementSold).toHaveBeenCalledWith(TYPE_ID, 1);
    expect(setTicketRefundStatus).toHaveBeenCalledWith(TICKET_ID, 'refunded');
    expect(result).toEqual({ ticket: { id: TICKET_ID, status: 'refunded' } });
  });

  it('answers 502 and changes nothing when pay refuses', async () => {
    vi.mocked(requestPayRefund).mockResolvedValue({ ok: false, status: 500, text: 'Stripe error' });

    const error = await failure(refundTicket(TARGET));

    expect(error).toMatchObject({
      code: 'unavailable',
      status: 502,
      message: 'Payment refund failed — ticket status not changed',
    });
    expect(logMock.error).toHaveBeenCalledWith(
      { status: 500, text: 'Stripe error' },
      '[refund] pay /api/refund returned error',
    );
    expect(decrementSold).not.toHaveBeenCalled();
    expect(setTicketRefundStatus).not.toHaveBeenCalled();
    expect(notifyRefundCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ['a free ticket', freeTicket],
    ['a zero-priced Stripe ticket', { ...stripeTicket, price_paid: 0 }],
    ['a Stripe ticket without a payment id', { ...stripeTicket, payment_id: null }],
    ['a ticket with no price recorded', { ...stripeTicket, price_paid: null }],
  ])('does not call pay for %s', async (_label, ticket) => {
    stockRefund(ticket);

    const result = await refundTicket(TARGET);

    expect(requestPayRefund).not.toHaveBeenCalled();
    expect(result.ticket.status).toBe('refunded');
  });
});

describe('refundTicket — sold counter', () => {
  it('skips the decrement when the ticket has no ticket type', async () => {
    stockRefund({ ...stripeTicket, ticket_type_id: null });

    await refundTicket(TARGET);

    expect(decrementSold).not.toHaveBeenCalled();
  });

  it('still refunds when the decrement fails (non-fatal)', async () => {
    vi.mocked(decrementSold).mockRejectedValue(new Error('db hiccup'));

    const result = await refundTicket(TARGET);

    expect(result.ticket.status).toBe('refunded');
    expect(logMock.error).toHaveBeenCalledWith(
      { err: 'Error: db hiccup' },
      '[refund] Failed to decrement ticket_types.sold (non-fatal)',
    );
  });
});

describe('refundTicket — e-Transfer and notifications', () => {
  it('parks e-Transfer refunds as refund_pending and reports the manual-refund details', async () => {
    stockRefund(etransferTicket, 'refund_pending');

    const result = await refundTicket(TARGET);

    expect(requestPayRefund).not.toHaveBeenCalled();
    expect(setTicketRefundStatus).toHaveBeenCalledWith(TICKET_ID, 'refund_pending');
    expect(result).toEqual({
      ticket: { id: TICKET_ID, status: 'refund_pending' },
      manualRefundRequired: true,
      refundEmail: BUYER_EMAIL,
      refundAmount: '275.00',
      refundCurrency: 'CAD',
    });
  });

  it('omits refundEmail when no customer email resolves', async () => {
    stockRefund(etransferTicket, 'refund_pending');
    vi.mocked(notifyRefundCustomer).mockResolvedValue(null);

    const result = await refundTicket(TARGET);

    expect(result).not.toHaveProperty('refundEmail');
    expect(result.manualRefundRequired).toBe(true);
  });

  it('notifies the customer with the refund facts and defaults the currency to CAD', async () => {
    const event = makeEvent();
    vi.mocked(findEventById).mockResolvedValue(event);
    stockRefund({ ...stripeTicket, currency: null });

    await refundTicket(TARGET);

    expect(notifyRefundCustomer).toHaveBeenCalledWith({
      did: ORGANIZER_DID,
      event,
      ticket: { ...stripeTicket, currency: null },
      isStripe: true,
      pricePaid: 27500,
      manualRefundRequired: false,
      priceDollars: '275.00',
      currency: 'CAD',
    });
  });
});

describe('markRefundSent', () => {
  beforeEach(() => {
    vi.mocked(findTicketStatus).mockResolvedValue({ id: TICKET_ID, status: 'refund_pending' });
    vi.mocked(markRefundSentRow).mockResolvedValue({ id: TICKET_ID, status: 'refunded' });
  });

  it('404s for an unknown event before any organizer check', async () => {
    vi.mocked(findEventById).mockResolvedValue(null);

    expect(await failure(markRefundSent(TARGET))).toMatchObject({ status: 404, message: 'Event not found' });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  it('403s for non-organizers', async () => {
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    expect(await failure(markRefundSent(TARGET))).toMatchObject({
      status: 403,
      message: 'Only event organizers can mark refunds as sent',
    });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, 'session=abc');
  });

  it('404s for an unknown ticket', async () => {
    vi.mocked(findTicketStatus).mockResolvedValue(null);

    expect(await failure(markRefundSent(TARGET))).toMatchObject({ status: 404, message: 'Ticket not found' });
    expect(findTicketStatus).toHaveBeenCalledWith(EVENT_ID, TICKET_ID);
  });

  it('400s unless the refund is pending', async () => {
    vi.mocked(findTicketStatus).mockResolvedValue({ id: TICKET_ID, status: 'valid' });

    expect(await failure(markRefundSent(TARGET))).toMatchObject({
      status: 400,
      message: 'Ticket is not in refund_pending status',
    });
    expect(markRefundSentRow).not.toHaveBeenCalled();
  });

  it('completes the pending refund', async () => {
    expect(await markRefundSent(TARGET)).toEqual({ ticket: { id: TICKET_ID, status: 'refunded' } });
    expect(markRefundSentRow).toHaveBeenCalledWith(TICKET_ID);
  });
});
