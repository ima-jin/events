import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUYER_DID,
  EVENT_ID,
  ORDER_ID,
  ORGANIZER_DID,
  TYPE_ID,
  isEventOrganizerMock,
  logMock,
  makeOrder,
  makeTicket,
  makeTicketType,
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
vi.mock('@/services/pay-refund', () => ({ requestPayRefund: vi.fn() }));
vi.mock('@/services/ticket-signing', () => ({ resolveTicketSignature: vi.fn() }));

import { findOrderById, insertOrder, markOrderRefunded } from '@/repositories/orders-repository';
import { decrementSold, incrementSold } from '@/repositories/ticket-types-repository';
import {
  findRefundableTicketsByOrder,
  insertTicket,
  markTicketsRefunded,
} from '@/repositories/tickets-repository';
import { ServiceError } from '@/services/errors';
import {
  createOrderWithTickets,
  refundOrder,
  validateCart,
  type CreateOrderWithTicketsParams,
} from '@/services/orders-service';
import { requestPayRefund } from '@/services/pay-refund';
import { resolveTicketSignature } from '@/services/ticket-signing';

const OTHER_TYPE = 'type_2';
const INPUT = { orderId: ORDER_ID, actorDid: ORGANIZER_DID, callerCookie: 'session=abc' };

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

describe('validateCart re-export', () => {
  it('is the cart-validation implementation', async () => {
    const { validateCart: original } = await import('@/services/cart-validation');

    expect(validateCart).toBe(original);
  });
});

describe('createOrderWithTickets', () => {
  const holdExpiresAt = new Date('2026-06-04T00:00:00Z');

  function params(overrides: Partial<CreateOrderWithTicketsParams> = {}): CreateOrderWithTicketsParams {
    return {
      eventId: EVENT_ID,
      buyerDid: BUYER_DID,
      cart: [{ ticketTypeId: TYPE_ID, quantity: 2 }],
      typesById: new Map([[TYPE_ID, makeTicketType({ price: 5000 })]]),
      totalQuantity: 2,
      totalAmount: 10000,
      currency: 'cad',
      paymentMethod: 'stripe',
      ticketStatus: 'valid',
      ...overrides,
    };
  }

  beforeEach(() => {
    resetOrdersMocks();
    vi.mocked(insertOrder).mockImplementation(async (values) => makeOrder({ ...values } as never));
    vi.mocked(insertTicket).mockImplementation(async (values) => makeTicket({ ...values } as never));
    vi.mocked(incrementSold).mockResolvedValue(undefined);
    vi.mocked(resolveTicketSignature).mockResolvedValue('sig');
  });

  it('inserts a completed order and one valid ticket per unit', async () => {
    const result = await createOrderWithTickets(
      params({ stripeSessionId: 'cs_1', paymentId: 'pi_1', buyerEmail: 'b@test.com', orderMetadata: { a: 1 } }),
    );

    expect(insertOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^ord_[0-9a-z]+_[0-9a-f]{8}$/),
        eventId: EVENT_ID,
        buyerDid: BUYER_DID,
        ticketTypeId: TYPE_ID,
        quantity: 2,
        amountTotal: 10000,
        currency: 'CAD',
        paymentMethod: 'stripe',
        stripeSessionId: 'cs_1',
        paymentId: 'pi_1',
        status: 'completed',
        purchasedAt: expect.any(Date),
        metadata: { a: 1 },
        buyerEmail: 'b@test.com',
      }),
    );
    expect(insertTicket).toHaveBeenCalledTimes(2);
    expect(insertTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^tkt_[0-9a-z]+_[0-9a-f]{6}_0$/),
        orderId: result.order.id,
        ticketTypeId: TYPE_ID,
        ownerDid: BUYER_DID,
        originalOwnerDid: BUYER_DID,
        pricePaid: 5000,
        currency: 'CAD',
        paymentId: 'pi_1',
        paymentMethod: 'stripe',
        status: 'valid',
        purchasedAt: expect.any(Date),
        signature: 'sig',
        heldBy: null,
        heldUntil: null,
        holdExpiresAt: null,
        registrationStatus: 'not_required',
        metadata: {},
      }),
    );
    expect(result.tickets).toHaveLength(2);
    expect(incrementSold).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied order id', async () => {
    await createOrderWithTickets(params({ orderId: 'ord_given' }));

    expect(insertOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'ord_given' }));
  });

  it('creates a pending order with held, unsigned tickets for e-Transfer holds', async () => {
    await createOrderWithTickets(
      params({
        paymentMethod: 'etransfer',
        ticketStatus: 'held',
        holdExpiresAt,
        ticketMetadata: { source: 'emt' },
        typesById: new Map([[TYPE_ID, makeTicketType({ requiresRegistration: true })]]),
      }),
    );

    expect(insertOrder).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', purchasedAt: null, stripeSessionId: null, paymentId: null, buyerEmail: null }),
    );
    expect(insertTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'held',
        purchasedAt: null,
        paymentId: null,
        heldBy: BUYER_DID,
        heldUntil: holdExpiresAt,
        holdExpiresAt,
        registrationStatus: 'pending',
        metadata: { source: 'emt' },
      }),
    );
  });

  it('leaves ticketTypeId null on the order for multi-type carts', async () => {
    await createOrderWithTickets(
      params({
        cart: [
          { ticketTypeId: TYPE_ID, quantity: 1 },
          { ticketTypeId: OTHER_TYPE, quantity: 1 },
        ],
        typesById: new Map([
          [TYPE_ID, makeTicketType()],
          [OTHER_TYPE, makeTicketType({ id: OTHER_TYPE, price: 100 })],
        ]),
      }),
    );

    expect(insertOrder).toHaveBeenCalledWith(expect.objectContaining({ ticketTypeId: null }));
    expect(insertTicket).toHaveBeenCalledWith(expect.objectContaining({ ticketTypeId: OTHER_TYPE, pricePaid: 100 }));
  });

  it('falls back to the Stripe session as the ticket payment reference', async () => {
    await createOrderWithTickets(params({ stripeSessionId: 'cs_1' }));

    expect(insertTicket).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'cs_1' }));
  });

  it('asks the signer for each ticket with the event signing context', async () => {
    const log = { warn: vi.fn() } as never;

    await createOrderWithTickets(
      params({
        customerEmail: 'b@test.com',
        eventDid: 'did:imajin:event',
        eventPrivateKey: 'abcd',
        log,
        cart: [{ ticketTypeId: TYPE_ID, quantity: 1 }],
      }),
    );

    expect(resolveTicketSignature).toHaveBeenCalledWith(
      expect.stringMatching(/^tkt_/),
      'valid',
      'b@test.com',
      { eventId: EVENT_ID, eventDid: 'did:imajin:event', eventPrivateKey: 'abcd', log },
    );
  });

  it('stores a null signature when the signer yields none', async () => {
    vi.mocked(resolveTicketSignature).mockResolvedValue(null);

    await createOrderWithTickets(params());

    expect(insertTicket).toHaveBeenCalledWith(expect.objectContaining({ signature: null }));
  });

  it('increments sold counts per cart item when asked', async () => {
    await createOrderWithTickets(
      params({
        incrementSold: true,
        cart: [
          { ticketTypeId: TYPE_ID, quantity: 2 },
          { ticketTypeId: OTHER_TYPE, quantity: 1 },
        ],
        typesById: new Map([
          [TYPE_ID, makeTicketType()],
          [OTHER_TYPE, makeTicketType({ id: OTHER_TYPE })],
        ]),
      }),
    );

    expect(incrementSold).toHaveBeenCalledWith(TYPE_ID, 2);
    expect(incrementSold).toHaveBeenCalledWith(OTHER_TYPE, 1);
  });
});

describe('refundOrder', () => {
  const tickets = [makeTicket({ id: 'tkt_1' }), makeTicket({ id: 'tkt_2' })];

  beforeEach(() => {
    resetOrdersMocks();
    vi.mocked(findOrderById).mockResolvedValue(makeOrder());
    vi.mocked(findRefundableTicketsByOrder).mockResolvedValue(tickets);
    vi.mocked(markTicketsRefunded).mockResolvedValue(undefined);
    vi.mocked(decrementSold).mockResolvedValue(undefined);
    vi.mocked(markOrderRefunded).mockResolvedValue(undefined);
    vi.mocked(requestPayRefund).mockResolvedValue({ ok: true });
  });

  it('404s for an unknown order', async () => {
    vi.mocked(findOrderById).mockResolvedValue(null);

    const error = await failure(refundOrder(INPUT));

    expect(error).toMatchObject({ code: 'not_found', status: 404, message: 'Order not found' });
    expect(isEventOrganizerMock).not.toHaveBeenCalled();
  });

  it('400s for an order that is already refunded', async () => {
    vi.mocked(findOrderById).mockResolvedValue(makeOrder({ status: 'refunded' }));

    const error = await failure(refundOrder(INPUT));

    expect(error).toMatchObject({ status: 400, message: 'Order already refunded' });
    expect(requestPayRefund).not.toHaveBeenCalled();
  });

  it("403s unless the caller organizes the order's event, forwarding the caller cookie", async () => {
    vi.mocked(findOrderById).mockResolvedValue(makeOrder({ eventId: 'evt_other' }));
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const error = await failure(refundOrder(INPUT));

    expect(error).toMatchObject({ status: 403, message: 'Only event organizers can issue refunds' });
    expect(isEventOrganizerMock).toHaveBeenCalledWith('evt_other', ORGANIZER_DID, 'session=abc');
    expect(findRefundableTicketsByOrder).not.toHaveBeenCalled();
  });

  it('400s when no valid/used tickets remain', async () => {
    vi.mocked(findRefundableTicketsByOrder).mockResolvedValue([]);

    const error = await failure(refundOrder(INPUT));

    expect(error).toMatchObject({ status: 400, message: 'No refundable tickets found in this order' });
    expect(requestPayRefund).not.toHaveBeenCalled();
  });

  it('answers 502 and changes nothing when the pay service refuses', async () => {
    vi.mocked(requestPayRefund).mockResolvedValue({ ok: false, status: 500, text: 'Stripe error' });

    const error = await failure(refundOrder(INPUT));

    expect(error).toMatchObject({
      code: 'unavailable',
      status: 502,
      message: 'Payment refund failed — order status not changed',
    });
    expect(logMock.error).toHaveBeenCalledWith(
      { status: 500, text: 'Stripe error' },
      '[order-refund] pay /api/refund returned error',
    );
    expect(markTicketsRefunded).not.toHaveBeenCalled();
    expect(markOrderRefunded).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('fully refunds a Stripe order through pay, then marks tickets and order', async () => {
    const result = await refundOrder(INPUT);

    expect(result).toEqual({ orderId: ORDER_ID, refundedTickets: 2, status: 'refunded' });
    expect(requestPayRefund).toHaveBeenCalledWith({ paymentId: 'pi_test', reason: 'order refund' });
    expect(markTicketsRefunded).toHaveBeenCalledWith(['tkt_1', 'tkt_2']);
    expect(decrementSold).toHaveBeenCalledWith(TYPE_ID, 2);
    expect(markOrderRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(publishMock).toHaveBeenCalledWith('order.refunded', {
      issuer: ORGANIZER_DID,
      subject: BUYER_DID,
      scope: 'events',
      payload: {
        orderId: ORDER_ID,
        eventId: EVENT_ID,
        ticketIds: ['tkt_1', 'tkt_2'],
        amountTotal: 55000,
        currency: 'CAD',
        isStripe: true,
      },
    });
  });

  it('skips pay for non-Stripe orders and for Stripe orders without a payment id', async () => {
    vi.mocked(findOrderById).mockResolvedValueOnce(makeOrder({ paymentMethod: 'etransfer', paymentId: null }));
    await refundOrder(INPUT);
    vi.mocked(findOrderById).mockResolvedValueOnce(makeOrder({ paymentMethod: 'stripe', paymentId: null }));
    await refundOrder(INPUT);

    expect(requestPayRefund).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      'order.refunded',
      expect.objectContaining({ payload: expect.objectContaining({ isStripe: false }) }),
    );
  });

  it('decrements the sold counter once per distinct ticket type', async () => {
    vi.mocked(findRefundableTicketsByOrder).mockResolvedValue([
      makeTicket({ id: 'tkt_1', ticketTypeId: TYPE_ID }),
      makeTicket({ id: 'tkt_2', ticketTypeId: OTHER_TYPE }),
      makeTicket({ id: 'tkt_3', ticketTypeId: TYPE_ID }),
    ]);

    const result = await refundOrder(INPUT);

    expect(result.refundedTickets).toBe(3);
    expect(decrementSold).toHaveBeenCalledTimes(2);
    expect(decrementSold).toHaveBeenCalledWith(TYPE_ID, 2);
    expect(decrementSold).toHaveBeenCalledWith(OTHER_TYPE, 1);
  });

  it('still refunds when a sold-counter decrement fails (non-fatal)', async () => {
    vi.mocked(decrementSold).mockRejectedValue(new Error('counter fail'));

    const result = await refundOrder(INPUT);

    expect(result.status).toBe('refunded');
    expect(logMock.error).toHaveBeenCalledWith(
      { err: 'Error: counter fail' },
      '[order-refund] Failed to decrement ticket_types.sold (non-fatal)',
    );
    expect(markOrderRefunded).toHaveBeenCalledWith(ORDER_ID);
  });

  it('uses an "unknown" subject for orders without a buyer DID', async () => {
    vi.mocked(findOrderById).mockResolvedValue(makeOrder({ buyerDid: null }));

    await refundOrder(INPUT);

    expect(publishMock).toHaveBeenCalledWith('order.refunded', expect.objectContaining({ subject: 'unknown' }));
  });

  it('does not fail the refund when publishing rejects', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));

    await expect(refundOrder(INPUT)).resolves.toMatchObject({ status: 'refunded' });
    await vi.waitFor(() =>
      expect(logMock.error).toHaveBeenCalledWith(
        { err: 'Error: bus down' },
        '[order-refund] Failed to publish order.refunded',
      ),
    );
  });
});
