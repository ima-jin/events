import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUYER_DID,
  CREATOR_DID,
  EVENT_ID,
  ORDER_ID,
  ORGANIZER_DID,
  TICKET_ID,
  TYPE_ID,
  isEventOrganizerMock,
  logMock,
  makeEvent,
  makeOrder,
  makeTicket,
  publishMock,
  resetOrdersMocks,
} from '@/__tests__/support/orders-support';

vi.mock('@ima-jin/logger', async () => (await import('@/__tests__/support/orders-support')).loggerModuleMock());
vi.mock('@/lib/domain-events', async () =>
  (await import('@/__tests__/support/orders-support')).domainEventsModuleMock(),
);
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
vi.mock('@/services/order-confirmation-emails', () => ({ sendConfirmationEmails: vi.fn() }));

import { findEventById, findOrderById, markOrderCompleted } from '@/repositories/orders-repository';
import { incrementSold } from '@/repositories/ticket-types-repository';
import {
  findHeldEtransferTicketsByOrder,
  findTicketById,
  markHeldTicketsValid,
} from '@/repositories/tickets-repository';
import { ServiceError } from '@/services/errors';
import { sendConfirmationEmails } from '@/services/order-confirmation-emails';
import {
  confirmHeldTickets,
  confirmOrderPayment,
  confirmTicketPayment,
} from '@/services/order-confirmation';

const ACTOR = { actorDid: ORGANIZER_DID, callerCookie: 'session=abc' };
const OTHER_TYPE = 'type_2';

const held = (id: string, ticketTypeId = TYPE_ID) => makeTicket({ id, ticketTypeId, status: 'held' });
const valid = (id: string, ticketTypeId = TYPE_ID) => makeTicket({ id, ticketTypeId, status: 'valid' });

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

beforeEach(() => {
  resetOrdersMocks();
  vi.mocked(markHeldTicketsValid).mockImplementation(async (ids) => ids.map((id) => valid(id)));
  vi.mocked(markOrderCompleted).mockResolvedValue(undefined);
  vi.mocked(incrementSold).mockResolvedValue(undefined);
  vi.mocked(findEventById).mockResolvedValue(makeEvent());
  vi.mocked(sendConfirmationEmails).mockResolvedValue(undefined);
});

describe('confirmHeldTickets', () => {
  it('refuses an empty hold list', async () => {
    await expect(confirmHeldTickets(EVENT_ID, [], ORDER_ID)).rejects.toThrow('No held tickets to confirm');
    expect(markHeldTicketsValid).not.toHaveBeenCalled();
  });

  it('confirms the held tickets, completes the order and counts sales per type', async () => {
    const tickets = [held('tkt_1'), held('tkt_2', OTHER_TYPE), held('tkt_3')];
    vi.mocked(markHeldTicketsValid).mockImplementation(async (ids) =>
      ids.map((id, i) => valid(id, tickets[i].ticketTypeId)),
    );

    const result = await confirmHeldTickets(EVENT_ID, tickets, ORDER_ID);

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.confirmedTickets.map((t) => t.id)).toEqual(['tkt_1', 'tkt_2', 'tkt_3']);
    const [ids, at] = vi.mocked(markHeldTicketsValid).mock.calls[0];
    expect(ids).toEqual(['tkt_1', 'tkt_2', 'tkt_3']);
    expect(markOrderCompleted).toHaveBeenCalledWith(ORDER_ID, at);
    expect(incrementSold).toHaveBeenCalledTimes(2);
    expect(incrementSold).toHaveBeenCalledWith(TYPE_ID, 2);
    expect(incrementSold).toHaveBeenCalledWith(OTHER_TYPE, 1);
  });

  it('publishes ticket.purchased per confirmed ticket and sends the buyer emails', async () => {
    const event = makeEvent();
    vi.mocked(findEventById).mockResolvedValue(event);

    const { confirmedTickets } = await confirmHeldTickets(EVENT_ID, [held('tkt_1')], ORDER_ID);

    expect(findEventById).toHaveBeenCalledWith(EVENT_ID);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith('ticket.purchased', {
      issuer: BUYER_DID,
      subject: CREATOR_DID,
      scope: 'events',
      payload: {
        ticketId: 'tkt_1',
        eventId: EVENT_ID,
        amount: 27500,
        currency: 'CAD',
        context_id: EVENT_ID,
        context_type: 'event',
      },
    });
    expect(sendConfirmationEmails).toHaveBeenCalledWith(event, confirmedTickets, ORDER_ID);
  });

  it('does not touch an order for orphan tickets', async () => {
    await confirmHeldTickets(EVENT_ID, [held(TICKET_ID)], null);

    expect(markOrderCompleted).not.toHaveBeenCalled();
    expect(sendConfirmationEmails).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
  });

  it('uses fallbacks for tickets lacking an owner, price or currency', async () => {
    vi.mocked(markHeldTicketsValid).mockResolvedValue([
      makeTicket({ ownerDid: null, pricePaid: null, currency: null }),
    ]);

    await confirmHeldTickets(EVENT_ID, [held(TICKET_ID)], ORDER_ID);

    expect(publishMock).toHaveBeenCalledWith(
      'ticket.purchased',
      expect.objectContaining({
        issuer: '',
        payload: expect.objectContaining({ amount: 0, currency: 'USD' }),
      }),
    );
  });

  it('skips counters and ticket events when no ticket was still held, or emails when the event is gone', async () => {
    vi.mocked(markHeldTicketsValid).mockResolvedValue([]);
    await confirmHeldTickets(EVENT_ID, [held(TICKET_ID)], ORDER_ID);
    expect(incrementSold).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();

    vi.mocked(sendConfirmationEmails).mockClear();
    vi.mocked(markHeldTicketsValid).mockResolvedValue([valid(TICKET_ID)]);
    vi.mocked(findEventById).mockResolvedValue(null);
    await confirmHeldTickets(EVENT_ID, [held(TICKET_ID)], ORDER_ID);
    expect(sendConfirmationEmails).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith('ticket.purchased', expect.objectContaining({ subject: EVENT_ID }));
  });

  it('keeps the confirmation when the email block throws', async () => {
    vi.mocked(sendConfirmationEmails).mockRejectedValue(new Error('smtp down'));

    await expect(confirmHeldTickets(EVENT_ID, [held(TICKET_ID)], ORDER_ID)).resolves.toMatchObject({
      orderId: ORDER_ID,
    });
    expect(logMock.error).toHaveBeenCalledWith({ err: 'Error: smtp down' }, 'EMT confirm email block failed');
  });

  it('keeps the confirmation when publishing rejects', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));

    await expect(confirmHeldTickets(EVENT_ID, [held(TICKET_ID)], ORDER_ID)).resolves.toBeDefined();
    await vi.waitFor(() =>
      expect(logMock.error).toHaveBeenCalledWith({ err: 'Error: bus down' }, 'Publish error'),
    );
  });
});

describe('confirmOrderPayment', () => {
  beforeEach(() => {
    vi.mocked(findOrderById).mockResolvedValue(makeOrder({ status: 'pending' }));
    vi.mocked(findHeldEtransferTicketsByOrder).mockResolvedValue([held('tkt_1'), held('tkt_2')]);
  });

  it('404s for an unknown order', async () => {
    vi.mocked(findOrderById).mockResolvedValue(null);

    expect(await failure(confirmOrderPayment(ORDER_ID, ACTOR))).toMatchObject({
      status: 404,
      message: 'Order not found',
    });
  });

  it('400s unless the order is pending', async () => {
    vi.mocked(findOrderById).mockResolvedValue(makeOrder({ status: 'completed' }));

    expect(await failure(confirmOrderPayment(ORDER_ID, ACTOR))).toMatchObject({
      status: 400,
      message: 'Order is not in pending status',
    });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  it('403s for non-organizers, forwarding the caller cookie', async () => {
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    expect(await failure(confirmOrderPayment(ORDER_ID, ACTOR))).toMatchObject({
      status: 403,
      message: 'Not authorized',
    });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, 'session=abc');
    expect(findHeldEtransferTicketsByOrder).not.toHaveBeenCalled();
  });

  it('400s when the order has no held e-Transfer tickets', async () => {
    vi.mocked(findHeldEtransferTicketsByOrder).mockResolvedValue([]);

    expect(await failure(confirmOrderPayment(ORDER_ID, ACTOR))).toMatchObject({
      status: 400,
      message: 'No held e-Transfer tickets found in this order',
    });
  });

  it('confirms every held ticket and reports them', async () => {
    const result = await confirmOrderPayment(ORDER_ID, ACTOR);

    expect(result).toEqual({ confirmedCount: 2, orderId: ORDER_ID, tickets: ['tkt_1', 'tkt_2'] });
    expect(markOrderCompleted).toHaveBeenCalledWith(ORDER_ID, expect.any(Date));
  });
});

describe('confirmTicketPayment', () => {
  beforeEach(() => {
    vi.mocked(findTicketById).mockResolvedValue(held(TICKET_ID));
    vi.mocked(findHeldEtransferTicketsByOrder).mockResolvedValue([held('tkt_1'), held('tkt_2')]);
  });

  it('404s for an unknown ticket', async () => {
    vi.mocked(findTicketById).mockResolvedValue(null);

    expect(await failure(confirmTicketPayment(TICKET_ID, ACTOR))).toMatchObject({
      status: 404,
      message: 'Ticket not found',
    });
  });

  it('400s unless the ticket is held', async () => {
    vi.mocked(findTicketById).mockResolvedValue(valid(TICKET_ID));

    expect(await failure(confirmTicketPayment(TICKET_ID, ACTOR))).toMatchObject({
      status: 400,
      message: 'Ticket is not in held status',
    });
  });

  it('400s unless the hold is an e-Transfer', async () => {
    vi.mocked(findTicketById).mockResolvedValue(makeTicket({ status: 'held', paymentMethod: 'stripe' }));

    expect(await failure(confirmTicketPayment(TICKET_ID, ACTOR))).toMatchObject({
      status: 400,
      message: 'Ticket is not an e-Transfer hold',
    });
  });

  it('403s for non-organizers of the ticket event', async () => {
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    expect(await failure(confirmTicketPayment(TICKET_ID, ACTOR))).toMatchObject({
      status: 403,
      message: 'Not authorized',
    });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, 'session=abc');
  });

  it('confirms every held sibling when the ticket belongs to an order', async () => {
    const result = await confirmTicketPayment(TICKET_ID, ACTOR);

    expect(findHeldEtransferTicketsByOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(result.confirmedCount).toBe(2);
    expect(result.ticket.id).toBe('tkt_1');
    expect(result.orderId).toBe(ORDER_ID);
  });

  it('confirms just the ticket when it has no order', async () => {
    vi.mocked(findTicketById).mockResolvedValue(makeTicket({ id: TICKET_ID, status: 'held', orderId: null }));

    const result = await confirmTicketPayment(TICKET_ID, ACTOR);

    expect(findHeldEtransferTicketsByOrder).not.toHaveBeenCalled();
    expect(markOrderCompleted).not.toHaveBeenCalled();
    expect(result).toMatchObject({ confirmedCount: 1, orderId: null });
    expect(result.ticket.id).toBe(TICKET_ID);
  });
});
